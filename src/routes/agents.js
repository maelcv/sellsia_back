import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole, requireFeature } from "../middleware/auth.js";
import { requireTenantContext } from "../middleware/tenant.js";

const router = express.Router();

const adminAgentSchema = z.object({
  id: z.string().min(3).max(64),
  name: z.string().min(2).max(120),
  description: z.string().min(8).max(500),
  isActive: z.boolean().optional().default(true),
  agentType: z.enum(["local", "mistral-remote"]).optional().default("local"),
  mistralAgentId: z.string().max(128).optional().default("")
});

const tenantAgentSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().min(8).max(500),
  isActive: z.boolean().optional().default(true)
});

const importAgentSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().min(8).max(500),
  agentType: z.enum(["mistral-remote", "openai-remote"]),
  remoteAgentId: z.string().min(1).max(256)
});

const updateTenantAgentSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().min(8).max(500).optional(),
  isActive: z.boolean().optional()
});

// Map API agent type values to Prisma enum values
function toPrismaAgentType(apiValue) {
  if (apiValue === "mistral-remote") return "mistral_remote";
  if (apiValue === "openai-remote") return "openai_remote";
  return apiValue; // "local" stays "local"
}

// Map Prisma enum values back to API values
function toApiAgentType(prismaValue) {
  if (prismaValue === "mistral_remote") return "mistral-remote";
  if (prismaValue === "openai_remote") return "openai-remote";
  return prismaValue;
}

function formatAgent(a) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    is_active: a.isActive,
    agent_type: toApiAgentType(a.agentType),
    mistral_agent_id: a.mistralAgentId,
    tenant_id: a.tenantId || null,
    owner_id: a.ownerId || null,
    is_global: !a.tenantId
  };
}

/**
 * GET /api/agents/catalog
 * - Si le tenant a agents_local ou agents_cloud : retourne agents globaux + agents du tenant
 * - Sinon : retourne uniquement les agents globaux (plateforme)
 */
router.get("/catalog", requireAuth, requireTenantContext, async (req, res) => {
  const perms = req.tenantPlan?.permissions || {};
  const canSeeOwnAgents = req.user.role === "admin" || perms.agents_local || perms.agents_cloud;

  const whereClause = canSeeOwnAgents && req.tenantId
    ? { isActive: true, OR: [{ tenantId: null }, { tenantId: req.tenantId }] }
    : { isActive: true, tenantId: null };

  const agents = await prisma.agent.findMany({
    where: whereClause,
    select: {
      id: true, name: true, description: true, isActive: true,
      agentType: true, mistralAgentId: true, tenantId: true, ownerId: true
    },
    orderBy: { name: "asc" }
  });

  return res.json({ agents: agents.map(formatAgent) });
});

router.post("/admin", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = adminAgentSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "Invalid request payload" });

  const payload = parse.data;

  await prisma.agent.create({
    data: {
      id: payload.id,
      name: payload.name,
      description: payload.description,
      isActive: payload.isActive,
      agentType: toPrismaAgentType(payload.agentType),
      mistralAgentId: payload.agentType === "mistral-remote" ? (payload.mistralAgentId || null) : null
    }
  });

  return res.status(201).json({ message: "Agent created" });
});

router.patch("/admin/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = adminAgentSchema.omit({ id: true }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "Invalid request payload" });

  const payload = parse.data;

  try {
    await prisma.agent.update({
      where: { id: req.params.id },
      data: {
        name: payload.name,
        description: payload.description,
        isActive: payload.isActive,
        agentType: toPrismaAgentType(payload.agentType),
        mistralAgentId: payload.agentType === "mistral-remote" ? (payload.mistralAgentId || null) : null
      }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Agent not found" });
    }
    throw err;
  }

  return res.json({ message: "Agent updated" });
});

router.delete("/admin/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    await prisma.agent.delete({
      where: { id: req.params.id }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Agent not found" });
    }
    throw err;
  }

  return res.json({ message: "Agent deleted" });
});

router.get("/my-access", requireAuth, requireTenantContext, async (req, res) => {
  const userId = req.user.sub;
  const perms = req.tenantPlan?.permissions || {};
  const canSeeOwnAgents = req.user.role === "admin" || perms.agents_local || perms.agents_cloud;

  const whereClause = canSeeOwnAgents && req.tenantId
    ? { isActive: true, OR: [{ tenantId: null }, { tenantId: req.tenantId }] }
    : { isActive: true, tenantId: null };

  const agents = await prisma.agent.findMany({
    where: whereClause,
    select: {
      id: true, name: true, description: true, tenantId: true,
      userAgentAccess: { where: { userId }, select: { status: true } }
    },
    orderBy: { name: "asc" }
  });

  const access = agents.map((agent) => {
    const uaa = agent.userAgentAccess[0] || null;
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: uaa ? uaa.status : null,
      isGranted: uaa?.status === "granted",
      is_global: !agent.tenantId
    };
  });

  return res.json({ access });
});

// ── Tenant-scoped agent routes ─────────────────────────────────

/**
 * POST /api/agents/tenant
 * Créer un agent local tenant-scoped (client avec feature agents_local)
 */
router.post(
  "/tenant",
  requireAuth,
  requireRole("client", "collaborator", "admin"),
  requireTenantContext,
  requireFeature("agents_local"),
  async (req, res) => {
    const parse = tenantAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    // Vérifier quota maxAgents
    if (req.tenantPlan && req.tenantId) {
      const currentCount = await prisma.agent.count({
        where: { tenantId: req.tenantId, isActive: true }
      });
      if (currentCount >= req.tenantPlan.maxAgents) {
        return res.status(429).json({
          error: `Quota d'agents atteint (${req.tenantPlan.maxAgents} max)`,
          quota: { used: currentCount, max: req.tenantPlan.maxAgents }
        });
      }
    }

    const { name, description, isActive } = parse.data;
    const agentId = `tenant-${req.tenantId?.slice(0, 8)}-${randomUUID().slice(0, 8)}`;

    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        name,
        description,
        isActive,
        agentType: "local",
        tenantId: req.tenantId,
        ownerId: req.user.sub
      }
    });

    return res.status(201).json({ message: "Agent créé", agent: formatAgent(agent) });
  }
);

/**
 * POST /api/agents/import
 * Importer un agent cloud (Mistral/OpenAI) dans le workspace (feature agents_cloud)
 */
router.post(
  "/import",
  requireAuth,
  requireRole("client", "collaborator", "admin"),
  requireTenantContext,
  requireFeature("agents_cloud"),
  async (req, res) => {
    const parse = importAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    // Vérifier quota maxAgents
    if (req.tenantPlan && req.tenantId) {
      const currentCount = await prisma.agent.count({
        where: { tenantId: req.tenantId, isActive: true }
      });
      if (currentCount >= req.tenantPlan.maxAgents) {
        return res.status(429).json({
          error: `Quota d'agents atteint (${req.tenantPlan.maxAgents} max)`,
          quota: { used: currentCount, max: req.tenantPlan.maxAgents }
        });
      }
    }

    const { name, description, agentType, remoteAgentId } = parse.data;
    const agentId = `${agentType === "mistral-remote" ? "mistral" : "openai"}-${req.tenantId?.slice(0, 8)}-${randomUUID().slice(0, 8)}`;

    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        name,
        description,
        isActive: true,
        agentType: toPrismaAgentType(agentType),
        mistralAgentId: remoteAgentId,
        tenantId: req.tenantId,
        ownerId: req.user.sub
      }
    });

    return res.status(201).json({ message: "Agent importé", agent: formatAgent(agent) });
  }
);

/**
 * PATCH /api/agents/tenant/:id
 * Mettre à jour un agent tenant-scoped (propriétaire du tenant seulement)
 */
router.patch(
  "/tenant/:id",
  requireAuth,
  requireRole("client", "collaborator", "admin"),
  requireTenantContext,
  async (req, res) => {
    const parse = updateTenantAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    // Vérifier ownership tenant (sauf admin)
    const existing = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Agent introuvable" });
    if (req.user.role !== "admin" && existing.tenantId !== req.tenantId) {
      return res.status(403).json({ error: "Vous ne pouvez modifier que les agents de votre workspace" });
    }

    const updateData = {};
    if (parse.data.name !== undefined) updateData.name = parse.data.name;
    if (parse.data.description !== undefined) updateData.description = parse.data.description;
    if (parse.data.isActive !== undefined) updateData.isActive = parse.data.isActive;

    const agent = await prisma.agent.update({ where: { id: req.params.id }, data: updateData });
    return res.json({ message: "Agent mis à jour", agent: formatAgent(agent) });
  }
);

/**
 * DELETE /api/agents/tenant/:id
 * Supprimer un agent tenant-scoped (propriétaire du tenant seulement)
 */
router.delete(
  "/tenant/:id",
  requireAuth,
  requireRole("client", "collaborator", "admin"),
  requireTenantContext,
  async (req, res) => {
    const existing = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Agent introuvable" });
    if (req.user.role !== "admin" && existing.tenantId !== req.tenantId) {
      return res.status(403).json({ error: "Vous ne pouvez supprimer que les agents de votre workspace" });
    }

    await prisma.agent.delete({ where: { id: req.params.id } });
    return res.json({ message: "Agent supprimé" });
  }
);

export default router;
