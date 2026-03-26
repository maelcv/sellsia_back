import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/agents-management/seed-base-agents
 * Create default agents (Admin, Director, Technical, Commercial)
 * Admin only
 */
router.post("/seed-base-agents", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    console.log("[agents-management] Seeding base agents...");
    const baseAgents = [
      {
        id: "agent-admin",
        name: "Admin",
        description: "Agent administratif pour la gestion plateforme",
        agentType: "local",
        isActive: true,
        workspaceId: null // Global
      },
      {
        id: "agent-director",
        name: "Directeur",
        description: "Agent pour la direction et les décisions stratégiques",
        agentType: "local",
        isActive: true,
        workspaceId: null // Global
      },
      {
        id: "agent-technical",
        name: "Technique",
        description: "Agent pour les questions techniques et l'implémentation",
        agentType: "local",
        isActive: true,
        workspaceId: null // Global
      },
      {
        id: "agent-commercial",
        name: "Commercial",
        description: "Agent pour les questions commerciales et les ventes",
        agentType: "local",
        isActive: true,
        workspaceId: null // Global
      }
    ];

    const agentPrompts = {
      "agent-admin": "Tu es un assistant administratif expert. Tu aides à la gestion des workflows et des processus administratifs.",
      "agent-director": "Tu es un conseiller stratégique expert. Tu aides à la prise de décision et à la planification stratégique.",
      "agent-technical": "Tu es un expert technique senior. Tu aides à la résolution de problèmes techniques et à l'implémentation de solutions.",
      "agent-commercial": "Tu es un expert commercial chevronné. Tu aides aux stratégies de vente, aux négociations et aux relations clients."
    };

    const created = [];
    for (const agentData of baseAgents) {
      console.log(`[agents-management] Checking agent ${agentData.id}...`);
      const existing = await prisma.agent.findUnique({
        where: { id: agentData.id }
      });

      if (!existing) {
        console.log(`[agents-management] Creating agent ${agentData.id}...`);
        const agent = await prisma.agent.create({
          data: agentData
        });
        console.log(`[agents-management] Created agent ${agent.id}`);

        // Create default AgentPrompt
        await prisma.agentPrompt.create({
          data: {
            agentId: agent.id,
            systemPrompt: agentPrompts[agent.id] || "",
            version: 1,
            isActive: true
          }
        });

        created.push(agent);
      } else {
        console.log(`[agents-management] Agent ${agentData.id} already exists, skipping`);
      }
    }

    // Return ALL base agents (not just newly created ones)
    const allBaseAgents = await prisma.agent.findMany({
      where: { id: { in: baseAgents.map(a => a.id) } }
    });

    console.log(`[agents-management] Seed complete: created ${created.length}, total: ${allBaseAgents.length} agents`);
    return res.json({
      success: true,
      created: created.length,
      agents: allBaseAgents
    });
  } catch (err) {
    console.error("[agents-management] Seed error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/agents-management/:agentId
 * Update agent details + system prompt (admin only)
 */
router.patch("/:agentId", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { agentId } = req.params;
    const { name, description, isActive, systemPrompt } = req.body;

    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    await prisma.agent.update({
      where: { id: agentId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
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

    const knowledge = await prisma.knowledgeDocument.findMany({
      where: {
        isActive: true,
        OR: [
          { clientId: null }, // Global knowledge
          { clientId: { gt: 0 } } // Local knowledge
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
    const { docId } = req.params;

    const doc = await prisma.knowledgeDocument.update({
      where: { id: docId },
      data: { isActive: false }
    });

    return res.json({ success: true, document: doc });
  } catch (err) {
    console.error("[agents-management] Delete knowledge error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
