/**
 * Workflow Queue — Exécution asynchrone des automations via BullMQ.
 *
 * Queue: "workflow-execution"
 * Job data: { automationId, triggerData, triggeredBy }
 *
 * Retry: 3 tentatives, backoff exponentiel (2s, 4s, 8s).
 * Fallback: si Redis indisponible, exécution synchrone directe.
 *
 * Usage :
 *   import { enqueueWorkflow, startWorkflowQueue, stopWorkflowQueue } from './workflow-queue.js';
 *   await enqueueWorkflow(automationId, triggerData, triggeredBy);
 */

import { Queue, Worker } from "bullmq";
import { runAutomation } from "../services/automations/automation-engine.js";
import { logger } from "../lib/logger.js";

const QUEUE_NAME = "workflow-execution";

let queue  = null;
let worker = null;
let redisAvailable = false;

// ─── Connexion Redis ──────────────────────────────────────────────

function getRedisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  // BullMQ utilise ioredis nativement — on passe les options de connexion
  const parsed = new URL(url);
  return {
    host:     parsed.hostname,
    port:     Number(parsed.port) || 6379,
    password: parsed.password || undefined,
    username: parsed.username || undefined,
    tls:      url.startsWith("rediss://") ? {} : undefined,
    maxRetriesPerRequest: null, // requis par BullMQ
    enableReadyCheck: false,
  };
}

// ─── Start / Stop ─────────────────────────────────────────────────

export async function startWorkflowQueue() {
  const connection = getRedisConnection();
  if (!connection) {
    logger.warn("[workflow-queue] REDIS_URL absent — mode dégradé (exécution synchrone)");
    return;
  }

  try {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts:  3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail:     { count: 500 },
      },
    });

    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const { automationId, triggerData, triggeredBy } = job.data;
        logger.info("[workflow-queue] Processing job", {
          jobId: job.id,
          automationId,
          attempt: job.attemptsMade + 1,
        });
        await runAutomation(automationId, triggerData, triggeredBy);
      },
      {
        connection,
        concurrency: 5,
      }
    );

    worker.on("completed", (job) => {
      logger.info("[workflow-queue] Job completed", { jobId: job.id });
    });

    worker.on("failed", (job, err) => {
      logger.error("[workflow-queue] Job failed", err, {
        jobId:    job?.id,
        attempts: job?.attemptsMade,
      });
    });

    redisAvailable = true;
    logger.info("[workflow-queue] Started — Redis connected");
  } catch (err) {
    logger.warn("[workflow-queue] Failed to connect to Redis — mode dégradé", { error: err.message });
    queue  = null;
    worker = null;
    redisAvailable = false;
  }
}

export async function stopWorkflowQueue() {
  try {
    await worker?.close();
    await queue?.close();
  } catch { /* ignore */ }
  queue  = null;
  worker = null;
}

// ─── Enqueue ─────────────────────────────────────────────────────

/**
 * Enfile un job d'exécution d'automation.
 * Fallback synchrone si Redis indisponible.
 *
 * @param {string} automationId
 * @param {object} triggerData
 * @param {string} triggeredBy
 * @returns {Promise<string|null>} jobId ou null si exécution synchrone
 */
export async function enqueueWorkflow(automationId, triggerData = {}, triggeredBy = "manual") {
  if (!redisAvailable || !queue) {
    // Mode dégradé : exécution synchrone immédiate
    logger.info("[workflow-queue] Fallback synchrone", { automationId, triggeredBy });
    await runAutomation(automationId, triggerData, triggeredBy);
    return null;
  }

  const job = await queue.add(
    "run",
    { automationId, triggerData, triggeredBy },
    {
      jobId: `${automationId}-${Date.now()}`,
    }
  );

  logger.info("[workflow-queue] Job enqueued", { jobId: job.id, automationId, triggeredBy });
  return job.id;
}
