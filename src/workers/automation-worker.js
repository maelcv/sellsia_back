/**
 * Automation Worker — Gère les triggers cron et événements plateforme.
 *
 * Pattern identique à market-reports-worker.js :
 *   - startAutomationWorker(prisma) → démarre les cron jobs + listeners d'événements
 *   - stopAutomationWorker()        → stoppe tout proprement
 *
 * Triggers supportés :
 *   - cron      → node-cron job par automation
 *   - event     → platteformeEmitter events (conversation.ended, reminder.triggered, etc.)
 *   - webhook   → déclenché via route POST /api/automations/webhook/:token
 *   - manual    → via POST /api/automations/:id/run
 */

import cron from "node-cron";
import { prisma } from "../prisma.js";
import { platformEmitter } from "../services/automation-events.js";
import { runAutomation } from "../services/automations/automation-engine.js";
import { logger } from "../lib/logger.js";

const cronJobs = new Map(); // automationId → cron.ScheduledTask
let eventListeners = []; // [{ event, listener }]
let running = false;

/**
 * Lance l'exécution d'une automation en gérant les erreurs.
 */
async function triggerAutomation(automationId, triggerData, triggeredBy) {
  try {
    logger.info("[automation-worker] Triggering automation", { automationId, triggeredBy });
    await runAutomation(automationId, triggerData, triggeredBy);
  } catch (err) {
    logger.error("[automation-worker] Run failed", err, { automationId });
  }
}

/**
 * Charge et programme tous les cron automations actives.
 */
async function scheduleCronAutomations() {
  // Arrêter les crons existants
  for (const [id, job] of cronJobs) {
    job.stop();
    cronJobs.delete(id);
  }

  const automations = await prisma.automation.findMany({
    where: { isActive: true, triggerType: "cron" },
    select: { id: true, name: true, triggerConfig: true },
  });

  for (const automation of automations) {
    let config = {};
    try {
      config = JSON.parse(automation.triggerConfig || "{}");
    } catch {
      continue;
    }

    const expr = config.cronExpr;
    if (!expr || !cron.validate(expr)) {
      logger.warn("[automation-worker] Invalid cron expression", { automationId: automation.id, expr });
      continue;
    }

    const job = cron.schedule(expr, () => {
      triggerAutomation(automation.id, {}, "cron");
    });

    cronJobs.set(automation.id, job);
    logger.info("[automation-worker] Scheduled cron", { automationId: automation.id, name: automation.name, expr });
  }
}

/**
 * Enregistre les listeners d'événements plateforme.
 */
async function registerEventListeners() {
  // Retirer les anciens listeners
  for (const { event, listener } of eventListeners) {
    platformEmitter.off(event, listener);
  }
  eventListeners = [];

  const automations = await prisma.automation.findMany({
    where: { isActive: true, triggerType: "event" },
    select: { id: true, workspaceId: true, triggerConfig: true },
  });

  for (const automation of automations) {
    let config = {};
    try {
      config = JSON.parse(automation.triggerConfig || "{}");
    } catch {
      continue;
    }

    const eventType = config.eventType;
    if (!eventType) continue;

    const listener = (payload) => {
      // Filtrer par workspaceId si l'automation est scopée
      if (automation.workspaceId && payload.workspaceId !== automation.workspaceId) return;
      triggerAutomation(automation.id, payload, `event:${eventType}`);
    };

    platformEmitter.on(eventType, listener);
    eventListeners.push({ event: eventType, listener });
  }

  logger.info("[automation-worker] Registered event listeners", { count: eventListeners.length });
}

/**
 * Recharge la configuration de toutes les automations.
 * Appelé au démarrage et après une modification via l'API.
 */
export async function reloadAutomations() {
  await Promise.all([scheduleCronAutomations(), registerEventListeners()]);
  logger.info("[automation-worker] Automations reloaded");
}

export async function startAutomationWorker() {
  if (running) return;
  running = true;
  logger.info("[automation-worker] Starting");
  await reloadAutomations();

  // Re-charger périodiquement (toutes les 5 minutes) pour prendre en compte
  // les nouvelles automations créées via l'API sans redémarrage.
  cron.schedule("*/5 * * * *", () => {
    reloadAutomations().catch((err) =>
      logger.error("[automation-worker] Reload failed", err)
    );
  });
}

export function stopAutomationWorker() {
  running = false;
  for (const [, job] of cronJobs) job.stop();
  cronJobs.clear();
  for (const { event, listener } of eventListeners) {
    platformEmitter.off(event, listener);
  }
  eventListeners = [];
  logger.info("[automation-worker] Stopped");
}
