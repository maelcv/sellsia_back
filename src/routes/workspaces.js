/**
 * workspaces.js — Gestion des workspaces (tenants) SaaS
 *
 * Routes admin : CRUD complet des workspaces
 * Routes client : création de sous-clients (si plan le permet)
 */

import express from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole, requireFeature } from "../middleware/auth.js";
import { requireTenantContext } from "../middleware/tenant.js";

const router = express.Router();

// ── Schemas ───────────────────────────────────────────────────

const createWorkspaceSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, "Slug: lettres minuscules, chiffres et tirets uniquement"),
  planId: z.number().int().positive(),
  ownerEmail: z.string().email().max(254),
  ownerPassword: z.string().min(8).max(128),
  ownerCompanyName: z.string().max(120).optional()
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/).optional(),
  planId: z.number().int().positive().optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional()
});

const createSubClientSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, "Slug: lettres minuscules, chiffres et tirets uniquement"),
  planId: z.number().int().positive().optional(),
  ownerEmail: z.string().email().max(254),
  ownerPassword: z.string().min(8).max(128),
  ownerCompanyName: z.string().max(120).optional()
});

// ── Helper ───────────────────────────────────────────────────

function formatWorkspace(tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    planId: tenant.planId,
    planName: tenant.tenantPlan?.name || tenant.plan || null,
    parentTenantId: tenant.parentTenantId || null,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    userCount: tenant._count?.users || 0,
    childCount: tenant._count?.children || 0
  };
}

// ── Admin routes ──────────────────────────────────────────────

/**
 * GET /api/workspaces
 * Liste tous les workspaces (admin seulement)
 */
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const tenants = await prisma.tenant.findMany({
    where: { status: { not: "deleted" } },
    include: {
      tenantPlan: { select: { id: true, name: true } },
      _count: { select: { users: true, children: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  return res.json({ workspaces: tenants.map(formatWorkspace) });
});

/**
 * GET /api/workspaces/my-children
 * Liste les sous-clients du tenant courant (client avec feature sub_clients)
 * IMPORTANT : Cette route doit être déclarée AVANT /:id pour ne pas être capturée par ce pattern
 */
router.get(
  "/my-children",
  requireAuth,
  requireRole("client", "collaborator"),
  requireTenantContext,
  requireFeature("sub_clients"),
  async (req, res) => {
    const tenants = await prisma.tenant.findMany({
      where: { parentTenantId: req.tenantId, status: { not: "deleted" } },
      include: {
        tenantPlan: { select: { id: true, name: true } },
        _count: { select: { users: true, children: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    // Quota utilisé
    const plan = req.tenantPlan;
    const maxSubClients = plan?.maxSubClients || 0;

    return res.json({
      workspaces: tenants.map(formatWorkspace),
      quota: { used: tenants.length, max: maxSubClients }
    });
  }
);

/**
 * GET /api/workspaces/:id
 * Détail d'un workspace (admin seulement)
 */
router.get("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.params.id },
    include: {
      tenantPlan: { select: { id: true, name: true, permissionsJson: true, maxSubClients: true, maxUsers: true, maxAgents: true } },
      _count: { select: { users: true, children: true } },
      children: {
        select: { id: true, name: true, slug: true, status: true, createdAt: true }
      }
    }
  });

  if (!tenant) {
    return res.status(404).json({ error: "Workspace introuvable" });
  }

  const users = await prisma.user.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, email: true, role: true, companyName: true, createdAt: true }
  });

  return res.json({
    workspace: {
      ...formatWorkspace(tenant),
      permissions: tenant.tenantPlan
        ? (() => { try { return JSON.parse(tenant.tenantPlan.permissionsJson || "{}"); } catch { return {}; } })()
        : {},
      quotas: tenant.tenantPlan
        ? { maxSubClients: tenant.tenantPlan.maxSubClients, maxUsers: tenant.tenantPlan.maxUsers, maxAgents: tenant.tenantPlan.maxAgents }
        : null,
      subClients: tenant.children,
      users
    }
  });
});

/**
 * POST /api/workspaces
 * Créer un workspace + user owner (admin seulement, transaction atomique)
 */
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = createWorkspaceSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
  }

  const { name, slug, planId, ownerEmail, ownerPassword, ownerCompanyName } = parse.data;

  // Vérifier que le plan existe
  const plan = await prisma.plan.findFirst({ where: { id: planId, isActive: true } });
  if (!plan) {
    return res.status(404).json({ error: "Plan introuvable ou inactif" });
  }

  // Vérifier unicité du slug
  const existingSlug = await prisma.tenant.findUnique({ where: { slug } });
  if (existingSlug) {
    return res.status(409).json({ error: "Ce slug est déjà utilisé" });
  }

  // Vérifier unicité de l'email owner
  const existingUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (existingUser) {
    return res.status(409).json({ error: "Un utilisateur avec cet email existe déjà" });
  }

  const passwordHash = await bcrypt.hash(ownerPassword, 12);

  // Création atomique : tenant + user owner
  const [tenant, owner] = await prisma.$transaction(async (tx) => {
    const newTenant = await tx.tenant.create({
      data: {
        name,
        slug,
        status: "active",
        plan: plan.name,
        planId
      }
    });

    const newOwner = await tx.user.create({
      data: {
        email: ownerEmail,
        passwordHash,
        role: "client",
        companyName: ownerCompanyName || name,
        tenantId: newTenant.id
      }
    });

    return [newTenant, newOwner];
  });

  await logAudit(req.user.sub, "WORKSPACE_CREATED", { tenantId: tenant.id, slug, ownerEmail });

  return res.status(201).json({
    message: "Workspace créé",
    workspace: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    owner: { id: owner.id, email: owner.email }
  });
});

/**
 * PATCH /api/workspaces/:id
 * Mettre à jour un workspace (admin seulement)
 */
router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = updateWorkspaceSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
  }

  const { name, slug, planId, status } = parse.data;

  if (slug) {
    const existing = await prisma.tenant.findFirst({
      where: { slug, id: { not: req.params.id } }
    });
    if (existing) {
      return res.status(409).json({ error: "Ce slug est déjà utilisé" });
    }
  }

  if (planId) {
    const plan = await prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) {
      return res.status(404).json({ error: "Plan introuvable ou inactif" });
    }
  }

  try {
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (slug !== undefined) updateData.slug = slug;
    if (planId !== undefined) updateData.planId = planId;
    if (status !== undefined) updateData.status = status;

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: updateData
    });

    await logAudit(req.user.sub, "WORKSPACE_UPDATED", { tenantId: req.params.id, changes: updateData });
    return res.json({ message: "Workspace mis à jour", workspace: { id: tenant.id, slug: tenant.slug, name: tenant.name } });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Workspace introuvable" });
    }
    throw err;
  }
});

/**
 * DELETE /api/workspaces/:id
 * Soft-delete d'un workspace (admin seulement)
 */
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    await prisma.tenant.update({
      where: { id: req.params.id },
      data: { status: "deleted" }
    });

    await logAudit(req.user.sub, "WORKSPACE_DELETED", { tenantId: req.params.id });
    return res.json({ message: "Workspace supprimé" });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Workspace introuvable" });
    }
    throw err;
  }
});

/**
 * GET /api/workspaces/:id/users
 * Liste les users d'un workspace (admin ou owner du workspace)
 */
router.get("/:id/users", requireAuth, requireTenantContext, async (req, res) => {
  const tenantId = req.params.id;

  // Admin voit tout ; client ne peut voir que son propre tenant
  if (req.user.role !== "admin" && req.tenantId !== tenantId) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  const users = await prisma.user.findMany({
    where: { tenantId },
    select: { id: true, email: true, role: true, companyName: true, createdAt: true }
  });

  return res.json({ users });
});

/**
 * POST /api/workspaces/:tenantId/sub-clients
 * Créer un sous-client (client avec feature sub_clients)
 */
router.post(
  "/:tenantId/sub-clients",
  requireAuth,
  requireRole("client", "admin"),
  requireTenantContext,
  requireFeature("sub_clients"),
  async (req, res) => {
    const parentTenantId = req.user.role === "admin" ? req.params.tenantId : req.tenantId;

    const parse = createSubClientSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    const { name, slug, planId, ownerEmail, ownerPassword, ownerCompanyName } = parse.data;

    // Vérifier quota maxSubClients
    if (req.user.role !== "admin" && req.tenantPlan) {
      const currentCount = await prisma.tenant.count({
        where: { parentTenantId, status: { not: "deleted" } }
      });
      if (currentCount >= req.tenantPlan.maxSubClients) {
        return res.status(429).json({
          error: `Quota de sous-clients atteint (${req.tenantPlan.maxSubClients} max)`,
          quota: { used: currentCount, max: req.tenantPlan.maxSubClients }
        });
      }
    }

    // Vérifier unicité slug
    const existingSlug = await prisma.tenant.findUnique({ where: { slug } });
    if (existingSlug) {
      return res.status(409).json({ error: "Ce slug est déjà utilisé" });
    }

    // Vérifier unicité email owner
    const existingUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (existingUser) {
      return res.status(409).json({ error: "Un utilisateur avec cet email existe déjà" });
    }

    // Déterminer le plan : celui spécifié ou hériter du parent
    let resolvedPlanId = planId;
    if (!resolvedPlanId) {
      const parentTenant = await prisma.tenant.findUnique({
        where: { id: parentTenantId },
        select: { planId: true }
      });
      resolvedPlanId = parentTenant?.planId || null;
    }

    const plan = resolvedPlanId
      ? await prisma.plan.findFirst({ where: { id: resolvedPlanId, isActive: true } })
      : null;

    const passwordHash = await bcrypt.hash(ownerPassword, 12);

    const [tenant, owner] = await prisma.$transaction(async (tx) => {
      const newTenant = await tx.tenant.create({
        data: {
          name,
          slug,
          status: "active",
          plan: plan?.name || "free",
          planId: resolvedPlanId || undefined,
          parentTenantId
        }
      });

      const newOwner = await tx.user.create({
        data: {
          email: ownerEmail,
          passwordHash,
          role: "client",
          companyName: ownerCompanyName || name,
          tenantId: newTenant.id
        }
      });

      return [newTenant, newOwner];
    });

    await logAudit(req.user.sub, "SUB_CLIENT_CREATED", {
      parentTenantId,
      childTenantId: tenant.id,
      slug,
      ownerEmail
    });

    return res.status(201).json({
      message: "Sous-client créé",
      workspace: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      owner: { id: owner.id, email: owner.email }
    });
  }
);

export default router;
