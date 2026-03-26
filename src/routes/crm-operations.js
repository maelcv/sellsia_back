/**
 * routes/crm-operations.js
 *
 * Opérations CRM avancées: enrichissement SIRET, import en masse, gestion des tâches.
 * Feature flag: data_enrichment, mass_import
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { requireFeature } from "../middleware/auth.js";
import { prisma } from "../prisma.js";

const router = Router();
router.use(requireAuth, requireWorkspaceContext);

// ── Enrichissement SIRET ─────────────────────────────────

router.post("/enrich/siret", requireFeature("data_enrichment"), async (req, res) => {
  const { siret } = z.object({ siret: z.string().regex(/^\d{14}$/) }).parse(req.body);

  // Vérifier si déjà enrichi
  let enriched = await prisma.siretEnrichment.findUnique({ where: { siret } });
  if (enriched && enriched.status === "completed") {
    return res.json(enriched);
  }

  // Créer job d'enrichissement
  enriched = await prisma.siretEnrichment.create({
    data: {
      userId: req.user.sub,
      workspaceId: req.workspaceId,
      siret,
      status: "pending",
    },
  });

  // TODO: déclencher worker asynchrone pour appel SIRENE API
  // Pour mainworkspace, juste retourner le job créé
  res.status(201).json(enriched);
});

router.get("/enrich/siret/:siret", async (req, res) => {
  const enriched = await prisma.siretEnrichment.findUnique({
    where: { siret: req.params.siret },
  });
  if (!enriched) return res.status(404).json({ error: "Enrichissement non trouvé" });
  res.json(enriched);
});

// ── Import en masse ──────────────────────────────────────

router.post("/import/upload", requireFeature("mass_import"), async (req, res) => {
  const { fileName, entityType, totalRows } = z.object({
    fileName: z.string(),
    entityType: z.enum(["company", "contact", "opportunity"]),
    totalRows: z.number().int().min(1),
  }).parse(req.body);

  const job = await prisma.bulkImportJob.create({
    data: {
      userId: req.user.sub,
      workspaceId: req.workspaceId,
      fileName,
      entityType,
      totalRows,
      status: "pending",
    },
  });

  res.status(201).json(job);
});

router.get("/import/jobs", requireFeature("mass_import"), async (req, res) => {
  const jobs = await prisma.bulkImportJob.findMany({
    where: { userId: req.user.sub },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({ jobs });
});

router.post("/import/:jobId/process", requireFeature("mass_import"), async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  const job = await prisma.bulkImportJob.findFirst({
    where: { id: jobId, userId: req.user.sub },
  });
  if (!job) return res.status(404).json({ error: "Job non trouvé" });

  // Marquer comme en cours de traitement
  await prisma.bulkImportJob.update({
    where: { id: jobId },
    data: { status: "processing" },
  });

  // TODO: déclencher worker pour traiter le fichier
  res.json({ status: "processing" });
});

// ── Tâches assignées ─────────────────────────────────────

router.post("/tasks", async (req, res) => {
  const { title, dueDate, assignedToId, entityType, entityId } = z.object({
    title: z.string().min(1),
    dueDate: z.string().datetime().optional(),
    assignedToId: z.number().optional(),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
  }).parse(req.body);

  const task = await prisma.taskAssignment.create({
    data: {
      userId: req.user.sub,
      workspaceId: req.workspaceId,
      title,
      dueDate: dueDate ? new Date(dueDate) : null,
      assignedToId: assignedToId ?? null,
      entityType,
      entityId,
      status: "pending",
    },
  });

  res.status(201).json(task);
});

router.get("/tasks", async (req, res) => {
  const status = req.query.status || "pending";
  const tasks = await prisma.taskAssignment.findMany({
    where: {
      userId: req.user.sub,
      ...(status !== "all" && { status }),
    },
    orderBy: { dueDate: "asc" },
    take: 100,
  });
  res.json({ tasks });
});

router.patch("/tasks/:taskId", async (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);
  const task = await prisma.taskAssignment.findFirst({
    where: { id: taskId, userId: req.user.sub },
  });
  if (!task) return res.status(404).json({ error: "Tâche non trouvée" });

  const updates = z.object({
    status: z.enum(["pending", "in_progress", "completed"]).optional(),
    title: z.string().optional(),
  }).parse(req.body);

  const updated = await prisma.taskAssignment.update({
    where: { id: taskId },
    data: updates,
  });

  res.json(updated);
});

export default router;
