/**
 * Market reports worker.
 * - Registers node-cron jobs from MarketReportSchedule rows
 * - Exposes an in-memory queue for HTTP-triggered runs
 * - Global concurrency cap = 2 to protect Puppeteer memory
 *
 * Mirrors the shape of backend/ia_models/reminders/reminder-service.js.
 */
import cron from "node-cron";
import { runGenericReport } from "../market/runners/generic-report.js";
import { runUnitReport } from "../market/runners/unit-report.js";

const GLOBAL_CONCURRENCY = 2;
let running = 0;
const queue = [];
const cronTasks = new Map(); // key = `${workspaceId}:${kind}` → task
let prismaRef = null;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log("[market-reports-worker]", ...args);
}

function drain() {
  while (running < GLOBAL_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    running++;
    Promise.resolve()
      .then(() => job.fn())
      .then((res) => job.resolve(res))
      .catch((err) => job.reject(err))
      .finally(() => {
        running--;
        drain();
      });
  }
}

/**
 * Enqueue an arbitrary runner. Returns a promise resolving with the result.
 */
export function enqueueJob(fn, label = "job") {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject, label });
    drain();
  });
}

export function enqueueGenericReport(opts) {
  return enqueueJob(() => runGenericReport(opts), `generic:${opts.workspaceId}`);
}

export function enqueueUnitReport(opts) {
  return enqueueJob(() => runUnitReport(opts), `unit:${opts.workspaceId}:${opts.clientId}`);
}

async function loadSchedules() {
  if (!prismaRef) return [];
  return prismaRef.marketReportSchedule.findMany({ where: { enabled: true } });
}

function registerSchedule(schedule) {
  const key = `${schedule.workspaceId}:${schedule.kind}`;
  const existing = cronTasks.get(key);
  if (existing) {
    try { existing.stop(); } catch { /* ignore */ }
    cronTasks.delete(key);
  }
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cronExpr)) {
    log(`invalid cron expression for ${key}: ${schedule.cronExpr}`);
    return;
  }
  const task = cron.schedule(
    schedule.cronExpr,
    async () => {
      try {
        if (schedule.kind === "generic") {
          await enqueueGenericReport({
            workspaceId: schedule.workspaceId,
            triggeredBy: "cron",
          });
        } else if (schedule.kind === "unit") {
          const clients = await prismaRef.marketClient.findMany({
            where: { workspaceId: schedule.workspaceId, active: true },
          });
          for (const c of clients) {
            await enqueueUnitReport({
              workspaceId: schedule.workspaceId,
              clientId: c.id,
              triggeredBy: "cron",
            });
          }
        }
        await prismaRef.marketReportSchedule.update({
          where: { id: schedule.id },
          data: { lastRunAt: new Date() },
        });
      } catch (err) {
        log(`cron run failed for ${key}: ${err.message}`);
      }
    },
    { timezone: schedule.timezone || "Europe/Paris" }
  );
  cronTasks.set(key, task);
  log(`registered ${key} → ${schedule.cronExpr} (${schedule.timezone || "Europe/Paris"})`);
}

/**
 * Rebuild cron jobs for a given workspace (call after PUT /schedules/:kind).
 */
export async function rebuildWorkspaceSchedules(workspaceId) {
  if (!prismaRef) return;
  for (const key of Array.from(cronTasks.keys())) {
    if (key.startsWith(`${workspaceId}:`)) {
      const t = cronTasks.get(key);
      try { t.stop(); } catch { /* ignore */ }
      cronTasks.delete(key);
    }
  }
  const rows = await prismaRef.marketReportSchedule.findMany({
    where: { workspaceId, enabled: true },
  });
  for (const s of rows) registerSchedule(s);
}

export async function startMarketReportsWorker(prisma) {
  prismaRef = prisma;
  const schedules = await loadSchedules();
  for (const s of schedules) registerSchedule(s);
  log(`started with ${schedules.length} schedules`);
}

export function stopMarketReportsWorker() {
  for (const [key, task] of cronTasks.entries()) {
    try { task.stop(); } catch { /* ignore */ }
    cronTasks.delete(key);
  }
  log("stopped");
}
