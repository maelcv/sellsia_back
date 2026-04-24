import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole, requireFeature } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";

const router = express.Router();

const toggleWorkspaceAgentSchema = z.object({
  agentId: z.string(),
  active: z.boolean()
});

const adminAgentSchema = z.object({
  id: z.string().min(3).max(64),
  name: z.string().min(2).max(120),
  description: z.string().min(8).max(500),
  isActive: z.boolean().optional().default(true),
  agentType: z.enum(["local", "mistral-remote"]).optional().default("local"),
  mistralAgentId: z.string().max(128).optional().default(""),
  defaultProviderCode: z.string().max(64).optional(),
  defaultModel: z.string().max(128).optional(),
});

const workspaceAgentSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().min(8).max(500),
  isActive: z.boolean().optional().default(true),
  imageUrl: z.string().url().max(512).optional(),
  systemPrompt: z.string().max(20000).optional(),
  allowedSubAgents: z.array(z.string()).optional().default([]),
  allowedTools: z.array(z.string()).optional().default([]),
  defaultProviderCode: z.string().max(64).optional(),
  defaultModel: z.string().max(128).optional(),
});

const importAgentSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().min(8).max(500),
  agentType: z.enum(["mistral-remote", "openai-remote"]),
  remoteAgentId: z.string().min(1).max(256)
});

const updateWorkspaceAgentSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().min(8).max(500).optional(),
  isActive: z.boolean().optional(),
  imageUrl: z.string().url().max(512).optional(),
  systemPrompt: z.string().max(20000).optional(),
  allowedSubAgents: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  defaultProviderCode: z.string().max(64).optional(),
  defaultModel: z.string().max(128).optional(),
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
    default_provider_code: a.defaultProviderCode || null,
    default_model: a.defaultModel || null,
    workspace_id: a.workspaceId || null,
    owner_id: a.ownerId || null,
    is_global: !a.workspaceId
  };
}

/**
 * GET /api/agents/catalog
 * - Si le workspace a agents_local ou agents_cloud : retourne agents globaux + agents du workspace
 * - Sinon : retourne uniquement les agents globaux (plateforme)
 */
router.get("/catalog", requireAuth, requireWorkspaceContext, async (req, res) => {
  const perms = req.workspacePlan?.permissions || {};
  const canSeeOwnAgents = req.user.role === "admin" || perms.agents_local || perms.agents_cloud;

  // Filter:
  // 1. Admin see ALL agents
  // 2. Others see Global Agents in Plan OR Agents belonging to their Workspace
  const whereClause = req.user.role === "admin"
    ? {}
    : {
        isActive: true,
        OR: [
          { workspaceId: req.workspaceId }, // Agents du workspace
          { AND: [{ workspaceId: null }, { id: { in: req.allowedAgentIds || [] } }] } // Agents globaux du plan
        ]
      };

  const agents = await prisma.agent.findMany({
    where: whereClause,
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
      mistralAgentId: payload.agentType === "mistral-remote" ? (payload.mistralAgentId || null) : null,
      defaultProviderCode: payload.defaultProviderCode || null,
      defaultModel: payload.defaultModel || null,
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
        mistralAgentId: payload.agentType === "mistral-remote" ? (payload.mistralAgentId || null) : null,
        defaultProviderCode: payload.defaultProviderCode || null,
        defaultModel: payload.defaultModel || null,
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

router.get("/my-access", requireAuth, requireWorkspaceContext, async (req, res) => {
  const userId = req.user.sub;
  const whereClause = req.user.role === "admin"
    ? {}
    : {
        isActive: true,
        OR: [
          { workspaceId: req.workspaceId },
          { AND: [{ workspaceId: null }, { id: { in: req.allowedAgentIds || [] } }] }
        ]
      };

  const agents = await prisma.agent.findMany({
    where: whereClause,
    select: {
      id: true, name: true, description: true, workspaceId: true,
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
      is_global: !agent.workspaceId
    };
  });

  return res.json({ access });
});

// ── Workspace-scoped agent routes ─────────────────────────────────

/**
 * POST /api/agents/workspace
 * Créer un agent local workspace-scoped (client avec feature agents_local)
 */
router.post(
  "/workspace",
  requireAuth,
  requireRole("client", "sub_client", "admin"),
  requireWorkspaceContext,
  requireFeature("agents_local"),
  async (req, res) => {
    const parse = workspaceAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    // Vérifier quota maxAgents
    if (req.workspacePlan && req.workspaceId) {
      const currentCount = await prisma.agent.count({
        where: { workspaceId: req.workspaceId, isActive: true }
      });
      if (currentCount >= req.workspacePlan.maxAgents) {
        return res.status(429).json({
          error: `Quota d'agents atteint (${req.workspacePlan.maxAgents} max)`,
          quota: { used: currentCount, max: req.workspacePlan.maxAgents }
        });
      }
    }

    const {
      name,
      description,
      isActive,
      imageUrl,
      systemPrompt,
      allowedSubAgents,
      allowedTools,
      defaultProviderCode,
      defaultModel,
    } = parse.data;
    const agentId = `workspace-${req.workspaceId?.slice(0, 8)}-${randomUUID().slice(0, 8)}`;

    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        name,
        description,
        isActive,
        agentType: "local",
        workspaceId: req.workspaceId,
        ownerId: req.user.sub,
        imageUrl: imageUrl || null,
        allowedSubAgents: JSON.stringify(allowedSubAgents),
        allowedTools: JSON.stringify(allowedTools),
        defaultProviderCode: defaultProviderCode || null,
        defaultModel: defaultModel || null,
      }
    });

    if (systemPrompt) {
      await prisma.agentPrompt.create({
        data: {
          agentId: agent.id,
          systemPrompt,
          version: 1,
          isActive: true,
          workspaceId: req.workspaceId,
        }
      });
    }

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
  requireRole("client", "sub_client", "admin"),
  requireWorkspaceContext,
  requireFeature("agents_cloud"),
  async (req, res) => {
    const parse = importAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    // Vérifier quota maxAgents
    if (req.workspacePlan && req.workspaceId) {
      const currentCount = await prisma.agent.count({
        where: { workspaceId: req.workspaceId, isActive: true }
      });
      if (currentCount >= req.workspacePlan.maxAgents) {
        return res.status(429).json({
          error: `Quota d'agents atteint (${req.workspacePlan.maxAgents} max)`,
          quota: { used: currentCount, max: req.workspacePlan.maxAgents }
        });
      }
    }

    const { name, description, agentType, remoteAgentId } = parse.data;
    const agentId = `${agentType === "mistral-remote" ? "mistral" : "openai"}-${req.workspaceId?.slice(0, 8)}-${randomUUID().slice(0, 8)}`;

    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        name,
        description,
        isActive: true,
        agentType: toPrismaAgentType(agentType),
        mistralAgentId: remoteAgentId,
        workspaceId: req.workspaceId,
        ownerId: req.user.sub
      }
    });

    return res.status(201).json({ message: "Agent importé", agent: formatAgent(agent) });
  }
);

/**
 * PATCH /api/agents/workspace/:id
 * Mettre à jour un agent workspace-scoped (propriétaire du workspace seulement)
 */
router.patch(
  "/workspace/:id",
  requireAuth,
  requireRole("client", "sub_client", "admin"),
  requireWorkspaceContext,
  async (req, res) => {
    const parse = updateWorkspaceAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    // Vérifier ownership workspace (sauf admin)
    const existing = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Agent introuvable" });
    if (req.user.role !== "admin" && existing.workspaceId !== req.workspaceId) {
      return res.status(403).json({ error: "Vous ne pouvez modifier que les agents de votre workspace" });
    }

    const {
      name,
      description,
      isActive,
      imageUrl,
      systemPrompt,
      allowedSubAgents,
      allowedTools,
      defaultProviderCode,
      defaultModel,
    } = parse.data;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (allowedSubAgents !== undefined) updateData.allowedSubAgents = JSON.stringify(allowedSubAgents);
    if (allowedTools !== undefined) updateData.allowedTools = JSON.stringify(allowedTools);
    if (defaultProviderCode !== undefined) updateData.defaultProviderCode = defaultProviderCode || null;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel || null;

    const agent = await prisma.agent.update({ where: { id: req.params.id }, data: updateData });

    if (systemPrompt !== undefined) {
      const existingPrompt = await prisma.agentPrompt.findFirst({
        where: { agentId: req.params.id, isActive: true }
      });
      if (existingPrompt) {
        await prisma.agentPrompt.update({ where: { id: existingPrompt.id }, data: { systemPrompt } });
      } else {
        await prisma.agentPrompt.create({
          data: { agentId: req.params.id, systemPrompt, version: 1, isActive: true, workspaceId: req.workspaceId }
        });
      }
    }

    return res.json({ message: "Agent mis à jour", agent: formatAgent(agent) });
  }
);

/**
 * DELETE /api/agents/workspace/:id
 * Supprimer un agent workspace-scoped (propriétaire du workspace seulement)
 */
router.delete(
  "/workspace/:id",
  requireAuth,
  requireRole("client", "sub_client", "admin"),
  requireWorkspaceContext,
  async (req, res) => {
    const existing = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Agent introuvable" });
    if (req.user.role !== "admin" && existing.workspaceId !== req.workspaceId) {
      return res.status(403).json({ error: "Vous ne pouvez supprimer que les agents de votre workspace" });
    }

    await prisma.agent.delete({ where: { id: req.params.id } });
    return res.json({ message: "Agent supprimé" });
  }
);

/**
 * POST /api/agents/workspace/toggle
 * Permet à un workspace d'activer/désactiver un agent autorisé par son plan
 */
router.post("/workspace/toggle", requireAuth, requireRole("client", "admin"), requireWorkspaceContext, async (req, res) => {
  const parse = toggleWorkspaceAgentSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Données invalides" });
  }

  const { agentId, active } = parse.data;

  // Vérifier que l'agent est autorisé par le plan (ou appartient au workspace)
  const isAllowed = (req.allowedAgentIds || []).includes(agentId);
  const isOwner = await prisma.agent.findFirst({
    where: { id: agentId, workspaceId: req.workspaceId }
  });

  if (!isAllowed && !isOwner) {
    return res.status(403).json({ error: "Cet agent n'est pas inclus dans votre plan ou ne vous appartient pas." });
  }

  if (active) {
    await prisma.workspaceAgentAccess.upsert({
      where: {
        workspaceId_agentId: { workspaceId: req.workspaceId, agentId }
      },
      create: {
        workspaceId: req.workspaceId,
        agentId,
        status: "granted"
      },
      update: {
        status: "granted"
      }
    });
  } else {
    // On peut soit supprimer, soit mettre en 'denied'
    await prisma.workspaceAgentAccess.deleteMany({
      where: { workspaceId: req.workspaceId, agentId }
    });
  }

  await logAudit(req.user.sub, "TENANT_AGENT_TOGGLED", { agentId, active, workspaceId: req.workspaceId });
  return res.json({ message: `Agent ${active ? "activé" : "désactivé"} avec succès` });
});

export default router;
