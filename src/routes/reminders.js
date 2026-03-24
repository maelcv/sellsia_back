/**
 * reminders.js — Routes API pour le système de rappels
 *
 * Toutes les routes sont protégées par requireAuth (JWT).
 * L'utilisateur ne peut accéder qu'à SES propres rappels (isolation par userId).
 *
 * Routes exposées :
 *   POST   /api/reminders              → Créer un rappel manuellement
 *   GET    /api/reminders              → Lister ses rappels (avec filtres optionnels)
 *   PATCH  /api/reminders/:id/cancel   → Annuler un rappel PENDING
 *   GET    /api/reminders/events       → SSE stream pour les notifications temps réel
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { reminderEmitter } from "../../ia_models/reminders/reminder-events.js";

const router = Router();

// --- Schéma de validation (Zod) ---------------------------------------

/**
 * Schéma pour la création d'un rappel.
 * Le frontend (ou un agent) envoie scheduled_at en UTC (ISO 8601).
 */
const createReminderSchema = z.object({
  taskDescription: z
    .string()
    .min(1, "La description ne peut pas être vide")
    .max(1000, "La description est trop longue (max 1000 caractères)"),

  scheduledAt: z
    .string()
    .datetime({ message: "scheduledAt doit être une date ISO 8601 valide (ex: 2025-03-25T09:00:00Z)" }),

  timezone: z
    .string()
    .default("Europe/Paris"),

  channel: z
    .enum(["chat", "whatsapp"])
    .default("chat"),

  targetPhone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "targetPhone doit être au format E.164 (ex: +33612345678)")
    .optional(),

  agentId: z
    .string()
    .optional(),
});

// --- POST /api/reminders — Créer un rappel ----------------------------

/**
 * Crée un nouveau rappel.
 *
 * Body JSON :
 *   taskDescription  (string, requis)
 *   scheduledAt      (string ISO 8601 UTC, requis)
 *   timezone         (string, optionnel, défaut "Europe/Paris")
 *   channel          (string, optionnel, défaut "chat")
 *   targetPhone      (string E.164, requis si channel="whatsapp")
 *   agentId          (string, optionnel)
 */
router.post("/", requireAuth, async (req, res) => {
  // Validation du corps de la requête
  const parsed = createReminderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Données invalides",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { taskDescription, scheduledAt, timezone, channel, targetPhone, agentId } = parsed.data;

  // Règle métier : targetPhone obligatoire si canal WhatsApp
  if (channel === "whatsapp" && !targetPhone) {
    return res.status(400).json({
      error: "targetPhone est requis pour le canal whatsapp",
    });
  }

  // Vérifie que la date n'est pas dans le passé (tolérance de 30 secondes)
  const scheduledDate = new Date(scheduledAt);
  const thirtySecondsAgo = new Date(Date.now() - 30_000);
  if (scheduledDate < thirtySecondsAgo) {
    return res.status(400).json({
      error: "scheduledAt ne peut pas être dans le passé",
    });
  }

  try {
    const reminder = await prisma.reminder.create({
      data: {
        userId: req.user.id,
        agentId: agentId || null,
        taskDescription,
        scheduledAt: scheduledDate,
        timezone,
        status: "PENDING",
        channel,
        targetPhone: targetPhone || null,
      },
    });

    return res.status(201).json({
      message: "Rappel planifié avec succès",
      reminder,
    });
  } catch (err) {
    console.error("[reminders] Erreur création rappel:", err);
    return res.status(500).json({ error: "Erreur interne lors de la création du rappel" });
  }
});

// --- GET /api/reminders — Lister ses rappels --------------------------

/**
 * Retourne la liste des rappels de l'utilisateur connecté.
 *
 * Query params optionnels :
 *   status  → filtrer par statut (PENDING | SENT | FAILED | CANCELLED)
 *   limit   → nombre de résultats max (défaut 50, max 200)
 *   offset  → pagination (défaut 0)
 */
router.get("/", requireAuth, async (req, res) => {
  const { status, limit = "50", offset = "0" } = req.query;

  // Validation basique des query params
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const offsetNum = parseInt(offset) || 0;

  // Construction du filtre
  const where = { userId: req.user.id };
  if (status) {
    const validStatuses = ["PENDING", "SENT", "FAILED", "CANCELLED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `status invalide. Valeurs acceptées : ${validStatuses.join(", ")}`,
      });
    }
    where.status = status;
  }

  try {
    const [reminders, total] = await Promise.all([
      prisma.reminder.findMany({
        where,
        orderBy: { scheduledAt: "desc" },
        take: limitNum,
        skip: offsetNum,
      }),
      prisma.reminder.count({ where }),
    ]);

    return res.json({
      reminders,
      pagination: {
        total,
        limit: limitNum,
        offset: offsetNum,
      },
    });
  } catch (err) {
    console.error("[reminders] Erreur liste rappels:", err);
    return res.status(500).json({ error: "Erreur interne lors de la récupération des rappels" });
  }
});

// --- PATCH /api/reminders/:id/cancel — Annuler un rappel --------------

/**
 * Annule un rappel PENDING.
 * Seul le propriétaire peut annuler son rappel.
 * Un rappel déjà SENT ou FAILED ne peut plus être annulé.
 */
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  const reminderId = parseInt(req.params.id);
  if (isNaN(reminderId)) {
    return res.status(400).json({ error: "ID de rappel invalide" });
  }

  try {
    // Vérifie que le rappel existe et appartient à l'utilisateur
    const reminder = await prisma.reminder.findFirst({
      where: {
        id: reminderId,
        userId: req.user.id,
      },
    });

    if (!reminder) {
      return res.status(404).json({ error: "Rappel introuvable" });
    }

    if (reminder.status !== "PENDING") {
      return res.status(409).json({
        error: `Impossible d'annuler un rappel avec le statut "${reminder.status}". Seuls les rappels PENDING peuvent être annulés.`,
      });
    }

    const updated = await prisma.reminder.update({
      where: { id: reminderId },
      data: { status: "CANCELLED" },
    });

    return res.json({
      message: "Rappel annulé",
      reminder: updated,
    });
  } catch (err) {
    console.error("[reminders] Erreur annulation rappel:", err);
    return res.status(500).json({ error: "Erreur interne lors de l'annulation du rappel" });
  }
});

// --- GET /api/reminders/events — SSE stream ---------------------------

/**
 * Server-Sent Events : le frontend s'abonne à ce endpoint pour recevoir
 * les notifications de rappels en temps réel.
 *
 * Protocole SSE :
 *   - Connection persistante (Content-Type: text/event-stream)
 *   - Un événement JSON est poussé quand un rappel "chat" est exécuté par le cron
 *   - EventSource côté frontend se reconnecte automatiquement si la connexion coupe
 *
 * Exemple d'événement reçu :
 *   data: {"id":42,"taskDescription":"Appeler le client Dupont","scheduledAt":"2025-03-25T09:00:00.000Z"}
 *
 * IMPORTANT : cette route doit être déclarée AVANT toute route avec paramètre "/:id"
 * pour éviter qu'Express la traite comme un ID de rappel.
 */
router.get("/events", requireAuth, (req, res) => {
  const userId = req.user.id;

  // --- Configuration des headers SSE ---
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Nécessaire pour les proxies (nginx, Railway) qui bufferisent la réponse
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders(); // Envoie les headers immédiatement

  // Message de confirmation de connexion (aide au debug côté frontend)
  res.write(`data: ${JSON.stringify({ type: "connected", userId })}\n\n`);

  // --- Écoute des événements du cron worker ---
  const onReminder = ({ userId: eventUserId, reminder }) => {
    // Filtre : n'envoie l'événement qu'au bon utilisateur
    if (eventUserId !== userId) return;

    const payload = JSON.stringify({
      type: "reminder",
      ...reminder,
    });
    res.write(`data: ${payload}\n\n`);
  };

  reminderEmitter.on("reminder", onReminder);

  // Heartbeat toutes les 30s pour maintenir la connexion active
  // (certains proxies ferment les connexions inactives après 60s)
  const heartbeatInterval = setInterval(() => {
    res.write(": heartbeat\n\n"); // Commentaire SSE, ignoré par EventSource
  }, 30_000);

  // --- Nettoyage à la déconnexion du client ---
  req.on("close", () => {
    reminderEmitter.off("reminder", onReminder);
    clearInterval(heartbeatInterval);
  });
});

export default router;
