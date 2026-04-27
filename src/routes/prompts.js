/**
 * Prompt Management Routes — CRUD pour les prompts système par agent/client.
 *
 * GET    /api/prompts/:agentId          — Récupérer le prompt actif
 * PUT    /api/prompts/:agentId          — Créer/mettre à jour un prompt custom
 * GET    /api/prompts/admin/all         — Lister tous les prompts (admin)
 * DELETE /api/prompts/admin/:id         — Supprimer un prompt (admin)
 */

import express from "express";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { SYSTEM_PROMPTS } from "../prompts/system/defaults.js";

const router = express.Router();

const promptUpdateSchema = z.object({
  systemPrompt: z.string().min(10).max(10000),
  description: z.string().max(500).optional(),
  clientId: z.number().int().positive().optional()
});

// ── GET /api/prompts/:agentId — Prompt actif pour un agent ──

router.get("/:agentId", requireAuth, async (req, res) => {
  const { agentId } = req.params;
  const userId = req.user.sub;
  const isAdmin = req.user.role === "ADMIN";

  // Chercher un prompt custom pour ce client
  const custom = await prisma.agentPrompt.findFirst({
    where: {
      agentId,
      isActive: true,
      OR: [
        { clientId: isAdmin ? null : userId },
        { clientId: null }
      ]
    },
    orderBy: [
      { clientId: "desc" },
      { version: "desc" }
    ],
    select: {
      id: true,
      agentId: true,
      clientId: true,
      version: true,
      systemPrompt: true,
      description: true,
      isActive: true,
      createdAt: true
    }
  });

  const defaultPrompt = SYSTEM_PROMPTS[agentId] || null;

  return res.json({
    activePrompt: custom || null,
    defaultPrompt,
    isCustom: custom != null,
    agentId
  });
});

// ── PUT /api/prompts/:agentId — Créer un prompt custom ──

router.put("/:agentId", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { agentId } = req.params;
  const parse = promptUpdateSchema.safeParse(req.body);

  if (!parse.success) {
    return res.status(400).json({ error: "Invalid prompt payload" });
  }

  const { systemPrompt, description, clientId } = parse.data;

  // Vérifier que l'agent existe
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true }
  });
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  // Déterminer la version
  const lastVersion = await prisma.agentPrompt.aggregate({
    _max: { version: true },
    where: {
      agentId,
      clientId: clientId || null
    }
  });

  const newVersion = (lastVersion._max.version || 0) + 1;

  // Désactiver les prompts précédents pour ce scope, puis insérer le nouveau
  await prisma.$transaction(async (tx) => {
    await tx.agentPrompt.updateMany({
      where: {
        agentId,
        clientId: clientId || null
      },
      data: { isActive: false }
    });

    await tx.agentPrompt.create({
      data: {
        agentId,
        clientId: clientId || null,
        version: newVersion,
        systemPrompt,
        description: description || null,
        isActive: true
      }
    });
  });

  await logAudit(req.user.sub, "PROMPT_UPDATED", { agentId, clientId, version: newVersion });

  return res.json({ message: "Prompt updated", version: newVersion });
});

// ── GET /api/prompts/admin/all — Tous les prompts (admin) ──

router.get("/admin/all", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const prompts = await prisma.$queryRaw`
    SELECT ap.id, ap.agent_id as "agentId", ap.client_id as "clientId", ap.version,
           ap.system_prompt as "systemPrompt", ap.description, ap.is_active as "isActive",
           ap.created_at as "createdAt",
           a.name as "agentName",
           u.email as "clientEmail", u.company_name as "clientCompany"
    FROM agent_prompts ap
    JOIN agents a ON a.id = ap.agent_id
    LEFT JOIN users u ON u.id = ap.client_id
    ORDER BY ap.agent_id, ap.version DESC`;

  const defaults = Object.entries(SYSTEM_PROMPTS).map(([agentId, prompt]) => ({
    agentId,
    prompt: prompt.slice(0, 200) + "...",
    fullPrompt: prompt
  }));

  return res.json({ prompts, defaults });
});

// ── DELETE /api/prompts/admin/:id — Supprimer un prompt ──

router.delete("/admin/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid prompt id" });
  }

  try {
    await prisma.agentPrompt.delete({
      where: { id }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Prompt not found" });
    }
    throw err;
  }

  await logAudit(req.user.sub, "PROMPT_DELETED", { promptId: id });
  return res.json({ message: "Prompt deleted" });
});

export default router;
