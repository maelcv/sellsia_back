import express from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

const adminAgentSchema = z.object({
  id: z.string().min(3).max(64),
  name: z.string().min(2).max(120),
  description: z.string().min(8).max(500),
  isActive: z.boolean().optional().default(true),
  agentType: z.enum(["local", "mistral-remote"]).optional().default("local"),
  mistralAgentId: z.string().max(128).optional().default("")
});

// Map API agent type values to Prisma enum values
function toPrismaAgentType(apiValue) {
  if (apiValue === "mistral-remote") return "mistral_remote";
  return apiValue; // "local" stays "local"
}

// Map Prisma enum values back to API values
function toApiAgentType(prismaValue) {
  if (prismaValue === "mistral_remote") return "mistral-remote";
  return prismaValue;
}

router.get("/catalog", requireAuth, async (_req, res) => {
  const agents = await prisma.agent.findMany({
    select: {
      id: true,
      name: true,
      description: true,
      isActive: true,
      agentType: true,
      mistralAgentId: true
    },
    orderBy: { name: "asc" }
  });

  return res.json({
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      is_active: a.isActive,
      agent_type: toApiAgentType(a.agentType),
      mistral_agent_id: a.mistralAgentId
    }))
  });
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

router.get("/my-access", requireAuth, async (req, res) => {
  const userId = req.user.sub;

  const agents = await prisma.agent.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      description: true,
      userAgentAccess: {
        where: { userId },
        select: { status: true }
      }
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
      isGranted: uaa?.status === "granted"
    };
  });

  return res.json({ access });
});

export default router;
