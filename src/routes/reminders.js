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
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { reminderEmitter } from "../../ia_models/reminders/reminder-events.js";

const router = Router();

// ── Rate limiting ──
// Prevent abuse: max 20 reminder creations per user per 15 minutes
const createReminderRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 reminders per window
  keyGenerator: (req) => {
    // Rate limit per user
    return `reminder-create-${req.user.sub}`;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many reminders created",
      message: "You've created too many reminders recently. Please wait before creating more.",
      retryAfter: "15 minutes"
    });
  },
  skip: (req) => {
    // Don't rate limit admin users
    return req.user?.role === "admin";
  }
});

// Rate limit cancellations: max 30 per user per 15 minutes
const cancelReminderRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `reminder-cancel-${req.user.sub}`,
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many cancellations",
      message: "You've cancelled too many reminders recently. Please wait.",
      retryAfter: "15 minutes"
    });
  },
  skip: (req) => req.user?.role === "admin"
});

// --- Schéma de validation (Zod) ---------------------------------------

/**
 * Validate that a timezone is valid using Intl API
 */
function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Schéma pour la création d'un rappel.
 * CRITICAL: Le frontend DOIT envoyer scheduled_at en UTC UNIQUEMENT (ISO 8601 avec Z)
 */
const createReminderSchema = z.object({
  taskDescription: z
    .string()
    .min(1, "La description ne peut pas être vide")
    .max(1000, "La description est trop longue (max 1000 caractères)"),

  scheduledAt: z
    .string()
    .regex(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d{3})?Z$/,
      "scheduledAt MUST be ISO 8601 UTC format ONLY (e.g., '2025-03-25T09:00:00Z' with Z suffix). DO NOT send in local time."
    )
    .datetime({ message: "Invalid ISO 8601 UTC format" }),

  timezone: z
    .string()
    .refine(isValidTimezone, "timezone is not a valid IANA timezone (e.g., 'Europe/Paris', 'America/New_York')")
    .default("Europe/Paris"),

  channel: z
    .enum(["chat", "whatsapp", "email", "push"])
    .default("chat"),

  targetPhone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "targetPhone doit être au format E.164 (ex: +33612345678)")
    .optional(),

  targetEmail: z
    .string()
    .email("targetEmail doit être une adresse email valide")
    .optional(),

  agentId: z
    .string()
    .optional(),
});

// --- POST /api/reminders — Créer un rappel ----------------------------

/**
 * Crée un nouveau rappel.
 *
 * CRITICAL API CONTRACT:
 *   scheduledAt MUST be ISO 8601 UTC format ONLY (with Z suffix)
 *   Example: "2025-03-25T09:00:00Z" (9 AM UTC, NOT your local time)
 *
 *   The timezone parameter is for DISPLAY ONLY (shows reminder time in user's local time)
 *   It does NOT affect when the reminder executes (always at scheduledAt in UTC)
 *
 * Body JSON :
 *   taskDescription  (string, required)  : What to remind about (max 1000 chars)
 *   scheduledAt      (string, required)  : ISO 8601 UTC time (e.g., "2025-03-25T09:00:00Z")
 *   timezone         (string, optional)  : IANA timezone for display (default "Europe/Paris")
 *                                           Examples: "Europe/Paris", "America/New_York", "Asia/Tokyo"
 *   channel          (string, optional)  : "chat" (in-app), "whatsapp", or "email" (default "chat")
 *   targetPhone      (string, required if channel="whatsapp")  : E.164 format (e.g., "+33612345678")
 *   targetEmail      (string, required if channel="email")    : Valid email address
 *   agentId          (string, optional)  : Which agent created this reminder
 *
 * EXAMPLE REQUEST:
 *   User in Paris wants reminder "tomorrow at 9 AM"
 *   Current time: 2025-03-25 15:00 UTC (16:00 Paris)
 *   Tomorrow 9 AM Paris = 2025-03-26 08:00 UTC
 *
 *   Frontend MUST send:
 *   {
 *     "taskDescription": "Call client Dupont",
 *     "scheduledAt": "2025-03-26T08:00:00Z",   // ← UTC, not Paris time!
 *     "timezone": "Europe/Paris",               // ← For display only
 *     "channel": "whatsapp",
 *     "targetPhone": "+33612345678"
 *   }
 */
router.post("/", requireAuth, requireWorkspaceContext, createReminderRateLimit, async (req, res) => {
  // Validation du corps de la requête
  const parsed = createReminderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Données invalides",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { taskDescription, scheduledAt, timezone, channel, targetPhone, targetEmail, agentId } = parsed.data;
  const effectiveChannel = channel === "push" ? "chat" : channel;

  // Règle métier : targetPhone obligatoire si canal WhatsApp
  if (effectiveChannel === "whatsapp" && !targetPhone) {
    return res.status(400).json({
      error: "targetPhone est requis pour le canal whatsapp",
    });
  }

  // Règle métier : targetEmail obligatoire si canal email
  if (effectiveChannel === "email" && !targetEmail) {
    return res.status(400).json({
      error: "targetEmail est requis pour le canal email",
    });
  }

  // Vérifie que la date n'est pas dans le passé (tolérance de 30 secondes)
  const scheduledDate = new Date(scheduledAt);
  const thirtySecondsAgo = new Date(Date.now() - 30_000);

  if (isNaN(scheduledDate.getTime())) {
    return res.status(400).json({
      error: "Invalid date",
      details: { scheduledAt: "Cannot parse scheduledAt as valid date" }
    });
  }

  if (scheduledDate < thirtySecondsAgo) {
    return res.status(400).json({
      error: "Invalid scheduled time",
      code: "PAST_DATE",
      details: {
        scheduledAt: "Reminder cannot be scheduled in the past",
        suggestion: "Use a future date/time in UTC format (e.g., 2025-03-26T09:00:00Z)"
      }
    });
  }

  // Add maximum reminder window (1 year)
  const maxDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  if (scheduledDate > maxDate) {
    return res.status(400).json({
      error: "Invalid scheduled time",
      code: "TOO_FAR_FUTURE",
      details: {
        scheduledAt: "Reminder cannot be scheduled more than 1 year in advance"
      }
    });
  }

  try {
    const reminder = await prisma.reminder.create({
      data: {
        userId: req.user.sub,
        agentId: agentId || null,
        taskDescription,
        scheduledAt: scheduledDate,
        timezone,
        status: "PENDING",
        channel: effectiveChannel,
        targetPhone: targetPhone || null,
        targetEmail: targetEmail || null,
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
router.get("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  const { status, limit = "50", offset = "0" } = req.query;

  // Strict validation of pagination bounds (prevent negative values)
  const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const offsetNum = Math.max(parseInt(offset) || 0, 0);

  // Construction du filtre
  const where = { userId: req.user.sub };
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
router.patch("/:id/cancel", requireAuth, requireWorkspaceContext, cancelReminderRateLimit, async (req, res) => {
  const reminderId = parseInt(req.params.id);
  if (isNaN(reminderId)) {
    return res.status(400).json({ error: "ID de rappel invalide" });
  }

  try {
    // Vérifie que le rappel existe et appartient à l'utilisateur
    const reminder = await prisma.reminder.findFirst({
      where: {
        id: reminderId,
        userId: req.user.sub,
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

    await prisma.taskAssignment.updateMany({
      where: {
        userId: req.user.sub,
        entityType: "reminder",
        entityId: String(reminderId),
        status: { in: ["pending", "in_progress"] },
      },
      data: { status: "cancelled" },
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
router.get("/events", (req, res) => {
  // EventSource ne supporte pas les headers custom — accepte le token en Bearer ou ?token=
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  if (!token) return res.status(401).json({ error: "Missing token" });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const userId = payload.sub;

  // --- Configuration des headers SSE ---
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Nécessaire pour les proxies (nginx, Railway) qui bufferisent la réponse
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders(); // Envoie les headers immédiatement

  // Message de confirmation de connexion (aide au debug côté frontend)
  try {
    res.write(`data: ${JSON.stringify({ type: "connected", userId })}\n\n`);
  } catch (err) {
    console.warn("[Reminders SSE] Failed to write connection message:", err.message);
    res.destroy();
    return;
  }

  // --- Cleanup function (called on any disconnect reason) ---
  const cleanup = () => {
    try {
      reminderEmitter.off("reminder", onReminder);
      clearInterval(heartbeatInterval);
    } catch (err) {
      console.warn("[Reminders SSE] Error during cleanup:", err.message);
    }
  };

  // --- Écoute des événements du cron worker ---
  const onReminder = ({ userId: eventUserId, reminder }) => {
    // Filtre : n'envoie l'événement qu'au bon utilisateur
    if (eventUserId !== userId) return;

    try {
      const payload = JSON.stringify({ reminder });
      // Événement nommé "reminder" — permet addEventListener("reminder", ...) côté client
      res.write(`event: reminder\ndata: ${payload}\n\n`);
    } catch (err) {
      // Write error — client likely disconnected
      console.warn(`[Reminders SSE] Failed to write to client (userId=${userId}):`, err.message);
      cleanup();
      res.destroy();
    }
  };

  reminderEmitter.on("reminder", onReminder);

  // Heartbeat toutes les 30s pour maintenir la connexion active
  // (certains proxies ferment les connexions inactives après 60s)
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(": heartbeat\n\n"); // Commentaire SSE, ignoré par EventSource
    } catch (err) {
      // Heartbeat failed — client disconnected
      console.debug(`[Reminders SSE] Heartbeat failed for userId=${userId}, cleaning up`);
      cleanup();
      if (!res.destroyed) {
        res.destroy();
      }
    }
  }, 30_000);

  // --- Nettoyage à la déconnexion du client ---
  // Handle multiple disconnect scenarios
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  req.on("error", (err) => {
    console.warn(`[Reminders SSE] Request error (userId=${userId}):`, err.message);
    cleanup();
  });

  res.on("error", (err) => {
    console.warn(`[Reminders SSE] Response error (userId=${userId}):`, err.message);
    cleanup();
  });
});

export default router;
