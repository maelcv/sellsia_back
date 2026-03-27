import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

import { 
  seedAgents, 
  seedSubAgents, 
  seedIntegrations 
} from "../lib/seed-lib.js";

/**
 * POST /api/agents-management/seed-base-agents
 * Create default agents, sub-agents, and integrations
 * Note: Does NOT seed AI providers as requested by the user
 * Admin only
 */
router.post("/seed-base-agents", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    console.log("[agents-management] Seeding plateforme entities (agents, sub-agents, integrations)...");
    
    const agentsCount = await seedAgents();
    const subAgentsCount = await seedSubAgents();
    const integrationsCount = await seedIntegrations();

    // Fetch all base agents to return in response
    const baseAgents = await prisma.agent.findMany({
      where: { workspaceId: null, isActive: true }
    });

    console.log(`[agents-management] Seed complete: agents=${agentsCount}, subAgents=${subAgentsCount}, integrations=${integrationsCount}`);
    
    return res.json({
      success: true,
      message: "Plateforme initialisée avec succès (Agents, Sous-agents, Intégrations). Les providers IA n'ont pas été modifiés.",
      counts: {
        agents: agentsCount,
        subAgents: subAgentsCount,
        integrations: integrationsCount
      },
      agents: baseAgents
    });
  } catch (err) {
    console.error("[agents-management] Seed error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents-management
 * Create a brand-new global agent with full configuration (admin only)
 */
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const createSchema = z.object({
      name: z.string().min(2).max(120),
      description: z.string().min(8).max(500),
      isActive: z.boolean().optional().default(true),
      agentType: z.enum(["local", "mistral-remote", "openai-remote"]).optional().default("local"),
      mistralAgentId: z.string().max(256).optional(),
      imageUrl: z.string().url().max(512).optional(),
      systemPrompt: z.string().max(20000).optional(),
      allowedSubAgents: z.array(z.string()).optional().default([]),
      allowedTools: z.array(z.string()).optional().default([]),
    });
    const parse = createSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }
    const { name, description, isActive, agentType, mistralAgentId, imageUrl, systemPrompt, allowedSubAgents, allowedTools } = parse.data;
    const agentId = `agent-${randomUUID().slice(0, 12)}`;
    const prismaAgentType = agentType === "mistral-remote" ? "mistral_remote" : agentType === "openai-remote" ? "openai_remote" : "local";

    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        name,
        description,
        isActive,
        agentType: prismaAgentType,
        mistralAgentId: mistralAgentId || null,
        imageUrl: imageUrl || null,
        allowedSubAgents: JSON.stringify(allowedSubAgents),
        allowedTools: JSON.stringify(allowedTools),
        workspaceId: null, // global
      }
    });

    if (systemPrompt) {
      await prisma.agentPrompt.create({
        data: { agentId: agent.id, systemPrompt, version: 1, isActive: true }
      });
    }

    const created = await prisma.agent.findUnique({
      where: { id: agent.id },
      include: { agentPrompts: { where: { isActive: true }, take: 1 } }
    });

    return res.status(201).json({ success: true, agent: created });
  } catch (err) {
    console.error("[agents-management] Create error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/agents-management/:agentId
 * Update agent details + system prompt + image + sub-agents/tools (admin only)
 */
router.patch("/:agentId", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { agentId } = req.params;
    const { name, description, isActive, systemPrompt, imageUrl, allowedSubAgents, allowedTools } = req.body;

    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    await prisma.agent.update({
      where: { id: agentId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(allowedSubAgents !== undefined && { allowedSubAgents: JSON.stringify(allowedSubAgents) }),
        ...(allowedTools !== undefined && { allowedTools: JSON.stringify(allowedTools) }),
      }
    });

    if (systemPrompt !== undefined) {
      const existingPrompt = await prisma.agentPrompt.findFirst({
        where: { agentId, isActive: true }
      });
      if (existingPrompt) {
        await prisma.agentPrompt.update({
          where: { id: existingPrompt.id },
          data: { systemPrompt }
        });
      } else {
        await prisma.agentPrompt.create({
          data: { agentId, systemPrompt, version: 1, isActive: true }
        });
      }
    }

    const updated = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { agentPrompts: { where: { isActive: true }, take: 1 } }
    });

    return res.json({ success: true, agent: updated });
  } catch (err) {
    console.error("[agents-management] Update error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/agents-management/:agentId
 * Delete a global agent (admin only)
 */
router.delete("/:agentId", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    await prisma.agent.delete({ where: { id: agentId } });
    return res.json({ success: true });
  } catch (err) {
    console.error("[agents-management] Delete error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents-management/:agentId
 * Get single agent with prompt (admin only)
 */
router.get("/:agentId", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { agentPrompts: { where: { isActive: true }, take: 1 } }
    });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    return res.json({ agent });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents-management/workspace/:workspaceId/available
 * Get all available agents for a workspace (global + workspace-scoped)
 * Client can see agents available to their workspace
 */
router.get("/workspace/:workspaceId/available", requireAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Security: non-admins can only query their own workspace
    if (req.user.role !== "admin" && req.user.workspaceId !== workspaceId) {
      return res.status(403).json({ error: "Accès refusé à ce workspace" });
    }

    // Get all agents (global + workspace-scoped)
    const agents = await prisma.agent.findMany({
      where: {
        isActive: true,
        id: { not: "agent-admin" }, // Exclude admin agent from workspace view
        OR: [
          { workspaceId: null }, // Global agents
          { workspaceId } // Workspace-specific agents
        ]
      },
      select: {
        id: true,
        name: true,
        description: true,
        agentType: true,
        workspaceId: true
      }
    });

    // Get workspace agent access for current user's workspace
    const access = await prisma.workspaceAgentAccess.findMany({
      where: { workspaceId },
      select: {
        agentId: true,
        status: true
      }
    });

    const accessMap = new Map(access.map(a => [a.agentId, a]));

    const result = agents.map(agent => ({
      ...agent,
      isEnabled: accessMap.get(agent.id)?.status === 'granted' ?? false
    }));

    return res.json({ agents: result });
  } catch (err) {
    console.error("[agents-management] Get available error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents-management/workspace/:workspaceId/agent/:agentId/toggle
 * Toggle agent enable/disable status for a workspace
 */
router.post("/workspace/:workspaceId/agent/:agentId/toggle", requireAuth, async (req, res) => {
  try {
    const { workspaceId, agentId } = req.params;
    const { isEnabled } = req.body;

    // Security: non-admins can only toggle agents in their own workspace
    if (req.user.role !== "admin" && req.user.workspaceId !== workspaceId) {
      return res.status(403).json({ error: "Accès refusé à ce workspace" });
    }

    // Find or create access record
    let access = await prisma.workspaceAgentAccess.findUnique({
      where: { workspaceId_agentId: { workspaceId, agentId } }
    });

    const newStatus = isEnabled ? 'granted' : 'revoked';

    if (!access) {
      access = await prisma.workspaceAgentAccess.create({
        data: {
          workspaceId,
          agentId,
          status: newStatus
        }
      });
    } else {
      access = await prisma.workspaceAgentAccess.update({
        where: { workspaceId_agentId: { workspaceId, agentId } },
        data: { status: newStatus }
      });
    }

    return res.json({ success: true, access });
  } catch (err) {
    console.error("[agents-management] Toggle error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents-management/workspace/:workspaceId/knowledge
 * Get all knowledge documents for a workspace (local + global)
 */
router.get("/workspace/:workspaceId/knowledge", requireAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Security: ensure requestor belongs to this workspace (unless admin)
    if (req.user.role !== "admin" && req.user.workspaceId !== workspaceId) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    // Get workspace users to find their knowledge docs
    const wsUsers = await prisma.user.findMany({
      where: { workspaceId },
      select: { id: true }
    });
    const wsUserIds = wsUsers.map(u => u.id);

    const knowledge = await prisma.knowledgeDocument.findMany({
      where: {
        isActive: true,
        OR: [
          { clientId: null, agentId: null }, // Global platform knowledge
          { clientId: { in: wsUserIds } },   // Knowledge from workspace users
        ]
      },
      select: {
        id: true,
        title: true,
        docType: true,
        clientId: true,
        agentId: true,
        isActive: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" }
    });

    return res.json({ documents: knowledge });
  } catch (err) {
    console.error("[agents-management] Get knowledge error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents-management/workspace/:workspaceId/knowledge
 * Create/upload a knowledge document
 */
const knowledgeSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.enum(["text", "faq", "process", "config", "api_doc"]),
  scope: z.enum(["local", "global"]), // local = single agent, global = all agents
  agentId: z.string().optional() // Required if scope='local'
});

router.post("/workspace/:workspaceId/knowledge", requireAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    if (req.user.role !== "admin" && req.user.workspaceId !== workspaceId) {
      return res.status(403).json({ error: "Accès refusé à ce workspace" });
    }

    const validated = knowledgeSchema.parse(req.body);

    if (validated.scope === "local" && !validated.agentId) {
      return res.status(400).json({ error: "agentId required for local scope" });
    }

    const doc = await prisma.knowledgeDocument.create({
      data: {
        title: validated.title,
        content: validated.content,
        docType: validated.type,
        agentId: validated.scope === "local" ? validated.agentId : null,
        clientId: null, // Workspace-level knowledge
        isActive: true
      }
    });

    return res.json({ success: true, document: doc });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error("[agents-management] Create knowledge error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/agents-management/workspace/:workspaceId/knowledge/:docId
 * Delete a knowledge document
 */
router.delete("/workspace/:workspaceId/knowledge/:docId", requireAuth, async (req, res) => {
  try {
    const { workspaceId, docId } = req.params;

    // Security: non-admins can only modify knowledge in their own workspace
    if (req.user.role !== "admin" && req.user.workspaceId !== workspaceId) {
      return res.status(403).json({ error: "Accès refusé à ce workspace" });
    }

    const docIdInt = parseInt(docId, 10);
    if (isNaN(docIdInt)) {
      return res.status(400).json({ error: "ID de document invalide" });
    }

    const doc = await prisma.knowledgeDocument.update({
      where: { id: docIdInt },
      data: { isActive: false }
    });

    return res.json({ success: true, document: doc });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Document introuvable" });
    }
    console.error("[agents-management] Delete knowledge error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
