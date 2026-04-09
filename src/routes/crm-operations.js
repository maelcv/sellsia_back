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

const PRIVATE_VISIBILITY_MARKER = "[PRIVATE]";

function isPrivateDescription(description) {
  return String(description || "").trim().toUpperCase().startsWith(PRIVATE_VISIBILITY_MARKER);
}

function stripVisibilityPrefix(description) {
  return String(description || "").replace(/^\[PRIVATE\]\s*/i, "").trim() || null;
}

function applyVisibilityPrefix(description, visibility) {
  const clean = stripVisibilityPrefix(description);
  if (visibility === "private") {
    return clean ? `[PRIVATE] ${clean}` : "[PRIVATE]";
  }
  return clean;
}

function mapTaskDisplayStatus(taskStatus) {
  if (taskStatus === "completed") return "finish";
  if (taskStatus === "cancelled") return "cancelled";
  if (taskStatus === "failed") return "fail";
  return "pending";
}

function mapReminderDisplayStatus(reminderStatus) {
  if (reminderStatus === "SENT") return "finish";
  if (reminderStatus === "FAILED") return "fail";
  if (reminderStatus === "CANCELLED") return "cancelled";
  return "pending";
}

function buildReminderLogs(reminder) {
  const logs = [];

  if (!reminder) return logs;

  if (reminder.status === "SENT") {
    logs.push({
      status: "success",
      at: reminder.sentAt || reminder.updatedAt || reminder.createdAt,
      message: "Rappel envoyé avec succès",
    });
  } else if (reminder.status === "FAILED") {
    logs.push({
      status: "fail",
      at: reminder.failedAt || reminder.updatedAt || reminder.createdAt,
      message: reminder.errorMessage || "Échec de l'envoi du rappel",
    });
  } else if (reminder.status === "CANCELLED") {
    logs.push({
      status: "cancelled",
      at: reminder.updatedAt || reminder.createdAt,
      message: "Rappel annulé",
    });
  } else {
    logs.push({
      status: "pending",
      at: reminder.scheduledAt,
      message: "Rappel en attente d'exécution",
    });
  }

  return logs;
}

async function enrichTasksWithReminder(tasks) {
  const reminderIdSet = new Set();

  for (const task of tasks) {
    if (task.entityType === "reminder" && task.entityId && /^\d+$/.test(String(task.entityId))) {
      reminderIdSet.add(Number(task.entityId));
    }
  }

  const reminders = reminderIdSet.size > 0
    ? await prisma.reminder.findMany({
        where: { id: { in: Array.from(reminderIdSet) } },
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

  return tasks.map((task) => {
    const reminderId = task.entityType === "reminder" && /^\d+$/.test(String(task.entityId || ""))
      ? Number(task.entityId)
      : null;
    const reminder = reminderId ? remindersById.get(reminderId) || null : null;
    const displayStatus = reminder
      ? mapReminderDisplayStatus(reminder.status)
      : mapTaskDisplayStatus(task.status);

    return {
      ...task,
      visibility: isPrivateDescription(task.description) ? "private" : "public",
      description: stripVisibilityPrefix(task.description),
      displayStatus,
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
      reminderLogs: buildReminderLogs(reminder),
    };
  });
}

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
  const { title, description, dueDate, assignedToId, entityType, entityId, visibility } = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    dueDate: z.string().datetime().optional(),
    assignedToId: z.number().optional(),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
  }).parse(req.body);

  const task = await prisma.taskAssignment.create({
    data: {
      userId: req.user.sub,
      workspaceId: req.workspaceId,
      title,
      description: applyVisibilityPrefix(description, visibility || "public"),
      dueDate: dueDate ? new Date(dueDate) : null,
      assignedToId: assignedToId ?? null,
      entityType,
      entityId,
      status: "pending",
    },
  });

  res.status(201).json({
    ...task,
    visibility: isPrivateDescription(task.description) ? "private" : "public",
    description: stripVisibilityPrefix(task.description),
  });
});

router.get("/tasks", async (req, res) => {
  const status = req.query.status || "pending";
  const isSubClient = req.user.role === "sub_client";

  const scopeFilter = isSubClient
    ? { userId: req.user.sub }
    : req.workspaceId
      ? { workspaceId: req.workspaceId }
      : {};

  let tasks = await prisma.taskAssignment.findMany({
    where: {
      ...scopeFilter,
      ...(status !== "all" && { status }),
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    take: 100,
  });

  if (req.user.role !== "admin" && req.user.role !== "client") {
    tasks = tasks.filter((task) => !isPrivateDescription(task.description) || task.userId === req.user.sub);
  }

  const enrichedTasks = await enrichTasksWithReminder(tasks);
  res.json({ tasks: enrichedTasks });
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
    description: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
  }).parse(req.body);

  const data = {
    ...(updates.status !== undefined && { status: updates.status }),
    ...(updates.title !== undefined && { title: updates.title }),
    ...(updates.description !== undefined && {
      description: applyVisibilityPrefix(updates.description, updates.visibility || (isPrivateDescription(task.description) ? "private" : "public")),
    }),
    ...(updates.visibility !== undefined && updates.description === undefined && {
      description: applyVisibilityPrefix(task.description, updates.visibility),
    }),
  };

  const updated = await prisma.taskAssignment.update({
    where: { id: taskId },
    data,
  });

  res.json({
    ...updated,
    visibility: isPrivateDescription(updated.description) ? "private" : "public",
    description: stripVisibilityPrefix(updated.description),
  });
});

// ── Enrichissement SIRET en batch ─────────────────────────────

router.post("/enrich/batch", requireFeature("data_enrichment"), async (req, res) => {
  const { sirets } = z.object({
    sirets: z.array(z.string().regex(/^\d{14}$/)).max(500),
  }).parse(req.body);

  const jobs = await Promise.all(
    sirets.map((siret) =>
      prisma.siretEnrichment.upsert({
        where: { siret },
        update: {},
        create: {
          userId: req.user.sub,
          workspaceId: req.workspaceId,
          siret,
          status: "pending",
        },
      })
    )
  );

  res.status(201).json({ count: jobs.length, jobs });
});

router.get("/enrich/batch-status", requireFeature("data_enrichment"), async (req, res) => {
  let sirets = req.query.sirets || [];
  if (!Array.isArray(sirets)) {
    sirets = [sirets];
  }
  if (sirets.length === 0) {
    return res.status(400).json({ error: "Veuillez fournir au moins un SIRET" });
  }

  const items = await prisma.siretEnrichment.findMany({
    where: { siret: { in: sirets } },
  });

  const done = items.filter((i) => i.status === "completed").length;
  res.json({ total: items.length, done, items });
});

export default router;
