/**
 * reminder-service.js
 *
 * Worker de fond qui vérifie toutes les minutes les rappels échus
 * et les envoie via le canal approprié (chat ou WhatsApp).
 *
 * Démarrage : appeler startReminderWorker() une seule fois au boot du serveur.
 * Arrêt propre : appeler stopReminderWorker() lors du SIGTERM.
 *
 * Flux d'exécution (toutes les minutes) :
 *   1. Récupère en DB les rappels PENDING dont scheduled_at <= maintenant (UTC)
 *   2. Pour chaque rappel :
 *      a. Met le status à SENT immédiatement (évite les doubles envois en cas
 *         de lenteur ou de chevauchement de deux exécutions du cron)
 *      b. Selon le canal :
 *         - "chat"     → émet un événement SSE via reminderEmitter
 *         - "whatsapp" → envoie un message WhatsApp via l'API Meta
 *      c. En cas d'erreur → status='FAILED', errorMessage = message d'erreur
 *   3. Traite max 50 rappels par cycle (protection contre les surcharges)
 */

import cron from "node-cron";
import { prisma } from "../../src/prisma.js";
import { reminderEmitter } from "./reminder-events.js";
import { sendReminderViaEmail } from "./reminder-email.js";

// --- Constantes -------------------------------------------------------

/** Nombre max de rappels traités par cycle (évite les pics de charge) */
const BATCH_SIZE = 50;

/** Référence à la tâche cron, utilisée pour l'arrêt propre */
let cronTask = null;

// --- Envoi WhatsApp ----------------------------------------------------

/**
 * Envoie un rappel via WhatsApp en utilisant l'API Meta Graph.
 *
 * Stratégie :
 *   - On cherche un compte WhatsApp Business actif associé à l'utilisateur.
 *   - On réutilise la logique existante de sendWhatsAppReply() via import dynamique
 *     pour ne pas créer de dépendance circulaire au boot.
 *
 * @param {Object} reminder - L'objet Reminder complet depuis la DB
 */
async function sendReminderViaWhatsApp(reminder) {
  if (!reminder.targetPhone) {
    throw new Error("Numéro cible manquant pour le canal WhatsApp");
  }

  // Import dynamique pour éviter les imports circulaires
  const { sendWhatsAppReply } = await import("../../src/routes/whatsapp.js");

  // Récupère le premier compte WhatsApp actif de l'utilisateur
  const account = await prisma.whatsappAccount.findFirst({
    where: {
      userId: reminder.userId,
      status: "active",
    },
  });

  if (!account) {
    throw new Error(`Aucun compte WhatsApp actif trouvé pour userId=${reminder.userId}`);
  }

  // Construit le message de rappel
  const message = `🔔 Rappel : ${reminder.taskDescription}`;

  // Réutilise la fonction existante (gère la fenêtre 24h, le template fallback, etc.)
  await sendWhatsAppReply(account, reminder.targetPhone, message);
}

// --- Logique principale du worker -------------------------------------

/**
 * Détecte si une erreur est transitoire (peut être retraitée)
 */
function isTransientError(err) {
  const message = (err?.message || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("network") ||
    message.includes("temporarily") ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNREFUSED"
  );
}

/**
 * Traite un lot de rappels échus.
 * Appelée toutes les minutes par le cron.
 */
async function processReminders() {
  let dueReminders;
  try {
    // Récupère tous les rappels PENDING dont l'heure est passée (en UTC)
    dueReminders = await prisma.reminder.findMany({
      where: {
        status: "PENDING",
        scheduledAt: {
          lte: new Date(), // <= maintenant (UTC)
        },
      },
      take: BATCH_SIZE,
      orderBy: {
        scheduledAt: "asc", // Les plus anciens en premier
      },
    });
  } catch (err) {
    // Skip if RLS policies prevent access due to missing tenant/user context
    if (err?.message?.includes("Tenant or user not found") || err?.message?.includes("FATAL")) {
      return;
    }
    throw err;
  }

  if (dueReminders.length === 0) return; // Rien à faire

  console.log(`[ReminderWorker] ${dueReminders.length} rappel(s) à traiter`);

  // Traite chaque rappel de manière séquentielle
  // (séquentiel = plus facile à déboguer qu'un Promise.all)
  for (const reminder of dueReminders) {
    try {
      // --- Étape 1 : Lock optimiste ---
      // On passe le status à SENT avant d'envoyer.
      // Si le serveur crashe après ça, le rappel ne sera PAS renvoyé (préférable
      // à un double envoi). On stocke sentAt pour la traçabilité.
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
        },
      });

      // --- Étape 2 : Envoi selon le canal ---
      if (reminder.channel === "chat") {
        // Émet l'événement SSE vers le(s) client(s) connecté(s) du bon utilisateur
        reminderEmitter.emit("reminder", {
          userId: reminder.userId,
          reminder: {
            id: reminder.id,
            taskDescription: reminder.taskDescription,
            scheduledAt: reminder.scheduledAt,
            agentId: reminder.agentId,
            channel: reminder.channel,
          },
        });

        console.log(`[ReminderWorker] Rappel #${reminder.id} envoyé via chat (SSE) pour userId=${reminder.userId}`);
      } else if (reminder.channel === "whatsapp") {
        await sendReminderViaWhatsApp(reminder);
        console.log(`[ReminderWorker] Rappel #${reminder.id} envoyé via WhatsApp → ${reminder.targetPhone}`);
      } else if (reminder.channel === "email") {
        await sendReminderViaEmail(reminder);
        console.log(`[ReminderWorker] Rappel #${reminder.id} envoyé via email → ${reminder.targetEmail}`);
      } else {
        // Canal inconnu — on considère quand même comme SENT pour ne pas bloquer
        console.warn(`[ReminderWorker] Canal inconnu "${reminder.channel}" pour rappel #${reminder.id}`);
      }
    } catch (err) {
      // --- Étape 3 : Gestion des erreurs ---
      console.error(`[ReminderWorker] Erreur rappel #${reminder.id}:`, err.message);

      const retryCount = reminder.retryCount || 0;
      const MAX_RETRIES = 3;

      // Detect if error is transient and retry count not exceeded
      if (isTransientError(err) && retryCount < MAX_RETRIES) {
        // Reschedule for 5 minutes later
        const nextAttempt = new Date(Date.now() + 5 * 60 * 1000);
        console.log(
          `[ReminderWorker] Transient error - rescheduling rappel #${reminder.id} for ${nextAttempt.toISOString()} (attempt ${retryCount + 1}/${MAX_RETRIES})`
        );

        await prisma.reminder.update({
          where: { id: reminder.id },
          data: {
            status: "PENDING", // Retour à PENDING pour retry
            scheduledAt: nextAttempt,
            retryCount: retryCount + 1,
            errorMessage: null, // Clear previous error
          },
        });
      } else {
        // Permanent failure or max retries exceeded
        console.error(
          `[ReminderWorker] Permanent failure for rappel #${reminder.id} (retries: ${retryCount}/${MAX_RETRIES})`
        );

        await prisma.reminder.update({
          where: { id: reminder.id },
          data: {
            status: "FAILED",
            errorMessage: err.message,
            failedAt: new Date(),
          },
        });

        // Notify user that reminder failed
        try {
          await notifyUserReminderFailed(reminder, err);
        } catch (notifyErr) {
          console.warn(
            `[ReminderWorker] Failed to notify user about failed reminder:`,
            notifyErr.message
          );
        }
      }
    }
  }
}

/**
 * Notifie l'utilisateur qu'un rappel n'a pas pu être livré
 * TODO: Implement in-app notifications via websocket or polling endpoint
 */
async function notifyUserReminderFailed(reminder, err) {
  const messages = {
    network: "Votre rappel n'a pas pu être livré (problème réseau). Nous continuerons à réessayer.",
    rate_limit:
      "Votre rappel est en attente (service temporairement occupé). Il sera livré sous peu.",
    no_listener:
      "Votre rappel attend que vous ouvriez l'application pour être livré.",
    config:
      "Votre rappel n'a pas pu être livré. Vérifiez votre configuration dans les paramètres.",
    auth: "Erreur d'authentification. Contactez le support.",
  };

  let errorType = "unknown";
  if (err?.message?.includes("WhatsApp account")) {
    errorType = "config";
  } else if (err?.code === "ETIMEDOUT" || err?.message?.includes("timeout")) {
    errorType = "network";
  } else if (err?.message?.includes("rate")) {
    errorType = "rate_limit";
  }

  const message = messages[errorType] || "Votre rappel n'a pas pu être livré.";

  // Log the failure for admin observability
  console.log(`[ReminderWorker] Reminder #${reminder.id} failed (${errorType}): ${message}`, {
    reminderId: reminder.id,
    userId: reminder.userId,
    errorType,
    taskDescription: reminder.taskDescription,
  });

  // TODO: When Notification model is implemented, create in-app notification:
  // await prisma.notification.create({
  //   data: {
  //     userId: reminder.userId,
  //     type: "REMINDER_FAILED",
  //     title: "Rappel non livré",
  //     message,
  //     data: JSON.stringify({
  //       reminderId: reminder.id,
  //       errorType,
  //       taskDescription: reminder.taskDescription,
  //     }),
  //   },
  // });
}

// --- API publique du module -------------------------------------------

/**
 * Démarre le worker de rappels.
 * À appeler UNE SEULE FOIS au démarrage du serveur.
 *
 * Le cron s'exécute toutes les minutes (expression "* * * * *").
 * Timezone UTC pour que la comparaison avec scheduled_at (UTC) soit cohérente.
 */
export function startReminderWorker() {
  if (cronTask) {
    console.warn("[ReminderWorker] Déjà démarré — appel ignoré");
    return;
  }

  console.log("[ReminderWorker] Démarrage du worker de rappels (toutes les minutes)");

  cronTask = cron.schedule(
    "* * * * *", // Chaque minute
    async () => {
      try {
        await processReminders();
      } catch (err) {
        // On attrape ici pour éviter que le cron ne s'arrête sur une erreur inattendue
        console.error("[ReminderWorker] Erreur inattendue dans processReminders:", err);
      }
    },
    {
      timezone: "UTC", // Toujours UTC — scheduled_at est stocké en UTC
    }
  );

  console.log("[ReminderWorker] Worker démarré avec succès");
}

/**
 * Arrête le worker proprement.
 * À appeler lors du SIGTERM pour un arrêt gracieux.
 */
export function stopReminderWorker() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log("[ReminderWorker] Worker arrêté");
  }
}
