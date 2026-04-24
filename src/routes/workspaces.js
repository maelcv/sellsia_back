/**
 * workspaces.js — Gestion des workspaces (workspaces) SaaS
 *
 * Routes admin : CRUD complet des workspaces
 * Routes client : création de sous-clients (si plan le permet)
 */

import express from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole, requireFeature } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { seedMarketForWorkspace } from "../seed-market.js";
import { seedSubAgentsForWorkspace } from "./sub-agents.js";
import { deleteWorkspaceVaultStorage } from "../services/vault/vault-service.js";

const router = express.Router();

// ── Schemas ───────────────────────────────────────────────────

const createWorkspaceSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, "Slug: lettres minuscules, chiffres et tirets uniquement"),
  planId: z.number().int().positive(),
  ownerId: z.number().int().positive()
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

function formatWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    status: workspace.status,
    planId: workspace.planId,
    planName: workspace.workspacePlan?.name || workspace.plan || null,
    parentWorkspaceId: workspace.parentWorkspaceId || null,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    userCount: workspace._count?.users || 0,
    childCount: workspace._count?.children || 0
  };
}

async function cleanupWorkspaceVault(workspaceId) {
  try {
    await deleteWorkspaceVaultStorage(workspaceId);
    return { deleted: true };
  } catch (err) {
    console.error("[workspaces] Failed to cleanup vault storage:", {
      workspaceId,
      error: err?.message || String(err)
    });
    return { deleted: false, error: "vault_cleanup_failed" };
  }
}

// ── Admin routes ──────────────────────────────────────────────

/**
 * GET /api/workspaces
 * Liste tous les workspaces (admin seulement)
 */
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const workspaces = await prisma.workspace.findMany({
    where: { status: { not: "deleted" } },
    include: {
      workspacePlan: { select: { id: true, name: true } },
      _count: { select: { users: true, children: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  return res.json({ workspaces: workspaces.map(formatWorkspace) });
});

/**
 * GET /api/workspaces/my-children
 * Liste les sous-clients du workspace courant (client avec feature sub_clients)
 * IMPORTANT : Cette route doit être déclarée AVANT /:id pour ne pas être capturée par ce pattern
 */
router.get(
  "/my-children",
  requireAuth,
  requireRole("client", "sub_client"),
  requireWorkspaceContext,
  requireFeature("sub_clients"),
  async (req, res) => {
    const workspaces = await prisma.workspace.findMany({
      where: { parentWorkspaceId: req.workspaceId, status: { not: "deleted" } },
      include: {
        workspacePlan: { select: { id: true, name: true } },
        _count: { select: { users: true, children: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    // Quota utilisé
    const plan = req.workspacePlan;
    const maxSubClients = plan?.maxSubClients || 0;

    return res.json({
      workspaces: workspaces.map(formatWorkspace),
      quota: { used: workspaces.length, max: maxSubClients }
    });
  }
);

/**
 * GET /api/workspaces/diagnostic
 * Debug endpoint: compare JWT vs DB user data
 */
router.get("/diagnostic", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { id: true, email: true, role: true, workspaceId: true }
  });

  return res.json({
    jwt_token: {
      sub: req.user.sub,
      role: req.user.role,
      workspaceId: req.user.workspaceId,
      email: req.user.email
    },
    database_user: user,
    match_role: req.user.role === user?.role,
    match_workspace: req.user.workspaceId === user?.workspaceId
  });
});

/**
 * GET /api/workspaces/me
 * Retourne le détail du workspace courant pour le client
 */
router.get("/me", requireAuth, requireWorkspaceContext, async (req, res) => {
  // Admins don't have a single workspace — they're global
  if (!req.workspaceId) {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { id: true, email: true, role: true, workspaceId: true }
    });

    console.error("[workspaces/me] User has no workspaceId", {
      userId: req.user.sub,
      role: req.user.role,
      userWorkspaceId: user?.workspaceId,
      jwtWorkspaceId: req.user.workspaceId,
      timestamp: new Date().toISOString()
    });

    // Return 400 for incomplete setup, 403 for admins
    if (req.user.role === "admin") {
      return res.status(403).json({
        error: "Admin users don't have a workspace. Use /api/workspaces instead."
      });
    }

    return res.status(400).json({
      error: "Account not fully configured",
      code: "NO_WORKSPACE",
      message: "Your account is not linked to a workspace. Please contact your administrator.",
      userRole: req.user.role,
      dbWorkspaceId: user?.workspaceId
    });
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: req.workspaceId },
    include: {
      workspacePlan: { 
        include: { 
          allowedAgents: { select: { id: true, name: true, description: true } }
        }
      },
      agents: {
        select: { id: true, name: true, description: true }
      },
      children: {
        where: { status: { not: "deleted" } },
        select: { id: true, name: true, slug: true, status: true }
      },
      _count: { select: { users: true } }
    }
  });

  if (!workspace) return res.status(404).json({ error: "Workspace introuvable" });

  const users = await prisma.user.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, email: true, role: true, createdAt: true }
  });

  // Récupérer les agents activés pour ce workspace (incluant les globaux accordés)
  const activeAgentAccess = await prisma.workspaceAgentAccess.findMany({
    where: { workspaceId: workspace.id, status: "granted" },
    include: { 
      agent: { 
        select: { id: true, name: true, description: true } 
      } 
    }
  });
  const activeIds = activeAgentAccess.map(a => a.agentId);
  const grantedAgents = activeAgentAccess.map(a => a.agent);

  return res.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      plan: workspace.workspacePlan ? {
        id: workspace.workspacePlan.id,
        name: workspace.workspacePlan.name,
        maxUsers: workspace.workspacePlan.maxUsers,
        maxAgents: workspace.workspacePlan.maxAgents,
        maxSubClients: workspace.workspacePlan.maxSubClients,
        monthlyTokenLimit: workspace.workspacePlan.monthlyTokenLimit,
        permissions: (() => { try { return JSON.parse(workspace.workspacePlan.permissionsJson || "{}"); } catch { return {}; } })()
      } : null,
      users,
      subClients: workspace.children,
      allowedAgents: (() => {
        const all = [
          ...(workspace.workspacePlan?.allowedAgents || []),
          ...workspace.agents,
          ...grantedAgents
        ];
        // Unique par ID
        const unique = Array.from(new Map(all.map(a => [a.id, a])).values());
        return unique.map(a => ({
          ...a,
          isActive: activeIds.includes(a.id)
        }));
      })()
    }
  });
});

/**
 * GET /api/workspaces/:id
 * Détail d'un workspace (admin seulement)
 */
router.get("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: req.params.id },
    include: {
      workspacePlan: { select: { id: true, name: true, permissionsJson: true, maxSubClients: true, maxUsers: true, maxAgents: true } },
      _count: { select: { users: true, children: true } },
      children: {
        select: { id: true, name: true, slug: true, status: true, createdAt: true }
      }
    }
  });

  if (!workspace) {
    return res.status(404).json({ error: "Workspace introuvable" });
  }

  const users = await prisma.user.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, email: true, role: true, companyName: true, createdAt: true }
  });

  return res.json({
    workspace: {
      ...formatWorkspace(workspace),
      permissions: workspace.workspacePlan
        ? (() => { try { return JSON.parse(workspace.workspacePlan.permissionsJson || "{}"); } catch { return {}; } })()
        : {},
      quotas: workspace.workspacePlan
        ? { maxSubClients: workspace.workspacePlan.maxSubClients, maxUsers: workspace.workspacePlan.maxUsers, maxAgents: workspace.workspacePlan.maxAgents }
        : null,
      subClients: workspace.children,
      users
    }
  });
});

/**
 * POST /api/workspaces/self-provision
 * Permet à un utilisateur client sans workspace de créer le sien.
 * Requiert auth mais PAS requireWorkspaceContext (l'user n'a pas encore de workspace).
 */
router.post("/self-provision", requireAuth, async (req, res) => {
  if (req.user.role === "admin") {
    return res.status(403).json({ error: "Les admins ne peuvent pas auto-provisionner un workspace." });
  }

  // Vérifier que l'user n'a pas déjà un workspace
  const existing = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { workspaceId: true, companyName: true, email: true }
  });
  if (existing?.workspaceId) {
    return res.status(409).json({ error: "Vous avez déjà un workspace." });
  }

  const { name } = req.body;
  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return res.status(400).json({ error: "name requis (min 2 caractères)" });
  }

  // Slug depuis le nom
  const baseSlug = name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "workspace";
  const unique = `${baseSlug}-${Date.now().toString(36)}`;

  // Plan par défaut : le premier plan actif
  const defaultPlan = await prisma.plan.findFirst({
    where: { isActive: true },
    orderBy: { id: "asc" }
  });

  try {
    const [workspace] = await prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          name: name.trim(),
          slug: unique,
          status: "active",
          plan: defaultPlan?.name || "starter",
          ...(defaultPlan ? { planId: defaultPlan.id } : {})
        }
      });
      await tx.user.update({
        where: { id: req.user.sub },
        data: { workspaceId: ws.id }
      });
      return [ws];
    });

    res.status(201).json({ workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/workspaces
 * Créer un workspace + user owner (admin seulement, transaction atomique)
 */
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = createWorkspaceSchema.safeParse(req.body);
  if (!parse.success) {
    console.error("[WORKSPACE_CREATE_ERROR]", parse.error.flatten());
    return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
  }

  const { name, slug, planId, ownerId } = parse.data;

  // Vérifier que le plan existe
  const plan = await prisma.plan.findFirst({ where: { id: planId, isActive: true } });
  if (!plan) {
    return res.status(404).json({ error: "Plan introuvable ou inactif" });
  }

  // Vérifier unicité du slug
  const existingSlug = await prisma.workspace.findUnique({ where: { slug } });
  if (existingSlug) {
    return res.status(409).json({ error: "Ce slug est déjà utilisé" });
  }

  const existingUser = await prisma.user.findUnique({ where: { id: ownerId } });
  if (!existingUser) {
    return res.status(404).json({ error: "Compte propriétaire introuvable" });
  }

  // Création atomique : workspace + user owner
  const [workspace, owner] = await prisma.$transaction(async (tx) => {
    const newWorkspace = await tx.workspace.create({
      data: {
        name,
        slug,
        status: "active",
        plan: plan.name,
        planId
      }
    });

    const updatedOwner = await tx.user.update({
      where: { id: ownerId },
      data: { workspaceId: newWorkspace.id }
    });

    return [newWorkspace, updatedOwner];
  });

  // Seed market report sources + default schedules (non-blocking on error)
  try {
    await seedMarketForWorkspace(prisma, workspace.id);
  } catch (err) {
    console.error("[WORKSPACE_CREATE] market seed failed:", err.message);
  }

  // Seed default sub-agent presets (non-blocking on error)
  try {
    await seedSubAgentsForWorkspace(prisma, workspace.id, ownerId);
  } catch (err) {
    console.error("[WORKSPACE_CREATE] sub-agent seed failed:", err.message);
  }

  await logAudit(req.user.sub, "WORKSPACE_CREATED", { workspaceId: workspace.id, slug, ownerId });

  return res.status(201).json({
    message: "Workspace créé",
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
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
    const existing = await prisma.workspace.findFirst({
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

    const workspace = await prisma.workspace.update({
      where: { id: req.params.id },
      data: updateData
    });

    let vaultCleanup = null;
    if (updateData.status === "deleted") {
      vaultCleanup = await cleanupWorkspaceVault(workspace.id);
    }

    const auditPayload = { workspaceId: req.params.id, changes: updateData };
    if (vaultCleanup) {
      auditPayload.vaultCleanup = vaultCleanup;
    }
    await logAudit(req.user.sub, "WORKSPACE_UPDATED", auditPayload);

    const response = {
      message: "Workspace mis à jour",
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name }
    };
    if (vaultCleanup) {
      response.vaultCleanup = vaultCleanup;
    }
    return res.json(response);
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
    const workspace = await prisma.workspace.update({
      where: { id: req.params.id },
      data: { status: "deleted" }
    });

    const vaultCleanup = await cleanupWorkspaceVault(workspace.id);

    await logAudit(req.user.sub, "WORKSPACE_DELETED", { workspaceId: req.params.id, vaultCleanup });
    return res.json({ message: "Workspace supprimé", vaultCleanup });
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
router.get("/:id/users", requireAuth, requireWorkspaceContext, async (req, res) => {
  const workspaceId = req.params.id;

  // Admin voit tout ; client ne peut voir que son propre workspace
  if (req.user.role !== "admin" && req.workspaceId !== workspaceId) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  const users = await prisma.user.findMany({
    where: { workspaceId },
    select: { id: true, email: true, role: true, companyName: true, createdAt: true }
  });

  return res.json({ users });
});

/**
 * POST /api/workspaces/:workspaceId/sub-clients
 * Créer un sous-client (client avec feature sub_clients)
 */
router.post(
  "/:workspaceId/sub-clients",
  requireAuth,
  requireRole("client", "admin"),
  requireWorkspaceContext,
  requireFeature("sub_clients"),
  async (req, res) => {
    const parentWorkspaceId = req.user.role === "admin" ? req.params.workspaceId : req.workspaceId;

    const parse = createSubClientSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    const { name, slug, planId, ownerEmail, ownerPassword, ownerCompanyName } = parse.data;

    // Vérifier quota maxSubClients
    if (req.user.role !== "admin" && req.workspacePlan) {
      const currentCount = await prisma.workspace.count({
        where: { parentWorkspaceId, status: { not: "deleted" } }
      });
      if (currentCount >= req.workspacePlan.maxSubClients) {
        return res.status(429).json({
          error: `Quota de sous-clients atteint (${req.workspacePlan.maxSubClients} max)`,
          quota: { used: currentCount, max: req.workspacePlan.maxSubClients }
        });
      }
    }

    // Vérifier unicité slug
    const existingSlug = await prisma.workspace.findUnique({ where: { slug } });
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
      const parentWorkspace = await prisma.workspace.findUnique({
        where: { id: parentWorkspaceId },
        select: { planId: true }
      });
      resolvedPlanId = parentWorkspace?.planId || null;
    }

    const plan = resolvedPlanId
      ? await prisma.plan.findFirst({ where: { id: resolvedPlanId, isActive: true } })
      : null;

    const passwordHash = await bcrypt.hash(ownerPassword, 12);

    const [workspace, owner] = await prisma.$transaction(async (tx) => {
      const newWorkspace = await tx.workspace.create({
        data: {
          name,
          slug,
          status: "active",
          plan: plan?.name || "free",
          planId: resolvedPlanId || undefined,
          parentWorkspaceId
        }
      });

      const newOwner = await tx.user.create({
        data: {
          email: ownerEmail,
          passwordHash,
          role: "client",
          companyName: ownerCompanyName || name,
          workspaceId: newWorkspace.id
        }
      });

      return [newWorkspace, newOwner];
    });

    // Seed default sub-agent presets (non-blocking on error)
    try {
      await seedSubAgentsForWorkspace(prisma, workspace.id, owner.id);
    } catch (err) {
      console.error("[SUB_CLIENT_CREATE] sub-agent seed failed:", err.message);
    }

    await logAudit(req.user.sub, "SUB_CLIENT_CREATED", {
      parentWorkspaceId,
      childWorkspaceId: workspace.id,
      slug,
      ownerEmail
    });

    return res.status(201).json({
      message: "Sous-client créé",
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      owner: { id: owner.id, email: owner.email }
    });
  }
);

/**
 * GET /api/workspaces/:id/tasks
 * Lister les tâches d'un workspace (admin seulement)
 */
router.get("/:id/tasks", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const tasks = await prisma.taskAssignment.findMany({
      where: { workspaceId: req.params.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const userIds = [...new Set(tasks.map((t) => t.userId).filter(Boolean))];
    const users = userIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
      : [];
    const usersById = new Map(users.map((u) => [u.id, u]));
    tasks.forEach((t) => { t.user = usersById.get(t.userId) || null; });

    const reminderIds = tasks
      .filter((task) => task.entityType === "reminder" && task.entityId && /^\d+$/.test(String(task.entityId)))
      .map((task) => Number(task.entityId));

    const reminders = reminderIds.length > 0
      ? await prisma.reminder.findMany({
          where: { id: { in: reminderIds } },
          select: {
            id: true,
            status: true,
            channel: true,
            scheduledAt: true,
            sentAt: true,
            failedAt: true,
            errorMessage: true,
            retryCount: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : [];

    const remindersById = new Map(reminders.map((r) => [r.id, r]));
    const mapTaskStatus = (taskStatus) => {
      if (taskStatus === "completed") return "finish";
      return "pending";
    };
    const mapReminderStatus = (reminderStatus) => {
      if (reminderStatus === "SENT") return "finish";
      if (reminderStatus === "FAILED") return "fail";
      if (reminderStatus === "CANCELLED") return "cancelled";
      return "pending";
    };

    const buildLogs = (reminder) => {
      if (!reminder) return [];
      if (reminder.status === "SENT") {
        return [{ status: "success", at: reminder.sentAt || reminder.updatedAt || reminder.createdAt, message: "Rappel envoyé avec succès" }];
      }
      if (reminder.status === "FAILED") {
        return [{ status: "fail", at: reminder.failedAt || reminder.updatedAt || reminder.createdAt, message: reminder.errorMessage || "Échec de l'envoi du rappel" }];
      }
      if (reminder.status === "CANCELLED") {
        return [{ status: "cancelled", at: reminder.updatedAt || reminder.createdAt, message: "Rappel annulé" }];
      }
      return [{ status: "pending", at: reminder.scheduledAt, message: "Rappel en attente d'exécution" }];
    };

    const enrichedTasks = tasks.map((task) => {
      const reminderId = task.entityType === "reminder" && /^\d+$/.test(String(task.entityId || ""))
        ? Number(task.entityId)
        : null;
      const reminder = reminderId ? remindersById.get(reminderId) || null : null;

      return {
        ...task,
        displayStatus: reminder ? mapReminderStatus(reminder.status) : mapTaskStatus(task.status),
        reminder: reminder
          ? {
              id: reminder.id,
              channel: reminder.channel,
              status: reminder.status,
              scheduledAt: reminder.scheduledAt,
              sentAt: reminder.sentAt,
              failedAt: reminder.failedAt,
              errorMessage: reminder.errorMessage,
              retryCount: reminder.retryCount,
            }
          : null,
        reminderLogs: buildLogs(reminder),
      };
    });

    return res.json({ tasks: enrichedTasks });
  } catch (err) {
    console.error("[workspaces] Failed to load workspace tasks:", err);
    return res.status(500).json({ error: "Impossible de charger les taches du workspace" });
  }
});

/**
 * GET /api/workspaces/:id/events
 * Lister les événements calendrier d'un workspace (admin seulement)
 */
router.get("/:id/events", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const events = await prisma.calendarEvent.findMany({
      where: { workspaceId: req.params.id },
      orderBy: { startAt: "desc" },
      take: 100,
      include: { user: { select: { id: true, email: true } } },
    });
    return res.json({ events });
  } catch (err) {
    console.error("[workspaces] Failed to load workspace events:", err);
    return res.status(500).json({ error: "Impossible de charger les evenements du workspace" });
  }
});

/**
 * POST /api/workspaces/:workspaceId/user-agent-access
 * Manage user access to workspace agents (client/admin only)
 */
router.post("/:workspaceId/user-agent-access", requireAuth, requireRole("client", "admin"), requireWorkspaceContext, async (req, res) => {
  const { userId, agentAccess } = z.object({
    userId: z.number().int().positive(),
    agentAccess: z.record(z.string(), z.boolean()),
  }).parse(req.body);

  // Verify user is in the same workspace
  const targetUser = await prisma.user.findFirst({
    where: { id: userId, workspaceId: req.workspaceId },
  });

  if (!targetUser) {
    return res.status(404).json({ error: "Utilisateur non trouvé dans ce workspace" });
  }

  // Get all agents in the workspace
  const workspace = await prisma.workspace.findUnique({
    where: { id: req.workspaceId },
    include: { agents: { select: { id: true } } },
  });

  if (!workspace) {
    return res.status(404).json({ error: "Workspace non trouvé" });
  }

  const workspaceAgentIds = workspace.agents.map((a) => a.id);

  // Update access for each agent
  const updates = await Promise.all(
    workspaceAgentIds.map(async (agentId) => {
      const hasAccess = agentAccess[agentId] === true;

      return prisma.userAgentAccess.upsert({
        where: { userId_agentId: { userId, agentId } },
        update: { status: hasAccess ? "granted" : "revoked" },
        create: {
          userId,
          agentId,
          status: hasAccess ? "granted" : "revoked",
        },
      });
    })
  );

  res.json({
    success: true,
    message: "Accès configuré avec succès",
    updates: updates.length,
  });
});

export default router;
