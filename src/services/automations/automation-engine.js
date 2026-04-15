/**
 * Automation Engine — Moteur d'exécution des automations.
 *
 * Fonctions clés :
 *  - resolveTemplate(str, context) → remplace {{...}} par valeurs réelles
 *  - executeStep(step, runContext) → exécute une étape selon son type
 *  - runAutomation(automationId, triggerData, triggeredBy) → crée un run + exécute
 *
 * Concurrence : max 3 runs simultanés par workspace.
 */

import { prisma } from "../../prisma.js";
import { logger } from "../../lib/logger.js";

const MAX_CONCURRENT_PER_WORKSPACE = 3;
const runningByWorkspace = new Map(); // workspaceId → count

// ─── Template resolver ────────────────────────────────────────────

/**
 * Remplace {{variable}} dans une chaîne avec les valeurs de context.
 * Supporte :
 *   {{trigger.data}}          → JSON.stringify(context.trigger)
 *   {{step_{id}.output}}      → JSON.stringify(context.steps[id].output)
 *   {{now}}                   → ISO timestamp
 *   {{date}}                  → date YYYY-MM-DD
 *   {{workspaceId}}           → context.workspaceId
 *
 * Pas d'eval — résolution par dictionnaire simple.
 */
export function resolveTemplate(str, context) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const k = key.trim();

    if (k === "now") return new Date().toISOString();
    if (k === "date") return new Date().toISOString().slice(0, 10);
    if (k === "workspaceId") return context.workspaceId || "";

    if (k === "trigger.data" || k === "trigger") {
      return JSON.stringify(context.trigger ?? {});
    }

    // step_{id}.output
    const stepMatch = k.match(/^step_(.+?)\.output(.*)$/);
    if (stepMatch) {
      const [, stepId, rest] = stepMatch;
      const stepOutput = context.steps?.[stepId]?.output;
      if (stepOutput === undefined) return "";
      if (!rest) return JSON.stringify(stepOutput);
      // Support basic dot-path: .field or .field.subfield
      const path = rest.replace(/^\./, "").split(".");
      let val = stepOutput;
      for (const seg of path) {
        val = val?.[seg];
      }
      return val === undefined ? "" : String(val);
    }

    return `{{${k}}}`;
  });
}

/**
 * Résout récursivement tous les templates dans un objet config.
 */
function resolveConfig(config, context) {
  if (typeof config === "string") return resolveTemplate(config, context);
  if (Array.isArray(config)) return config.map((v) => resolveConfig(v, context));
  if (config && typeof config === "object") {
    const out = {};
    for (const [k, v] of Object.entries(config)) {
      out[k] = resolveConfig(v, context);
    }
    return out;
  }
  return config;
}

// ─── Step executors ───────────────────────────────────────────────

async function executeStepAgent(config, context) {
  const { agentId, prompt } = resolveConfig(config, context);
  if (!agentId) throw new Error("agentId requis pour l'étape agent");

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } });
  if (!agent) throw new Error(`Agent ${agentId} introuvable`);

  // Placeholder — dans un vrai run, on appellerait orchestratorService ou directement LLM
  return { agentId, prompt, result: `[Agent ${agent.name} exécuté avec: ${prompt}]` };
}

async function executeStepTool(config, context) {
  const { toolName, params } = resolveConfig(config, context);
  // Import dynamique du registry tools pour éviter la dépendance circulaire
  const { ALL_TOOLS } = await import("../../tools/mcp/tools.js");
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Outil inconnu: ${toolName}`);

  return tool.execute(params || {}, {
    tenantId: context.workspaceId,
    isAdmin: false,
  });
}

async function executeStepHttpRequest(config, context) {
  const { url, method = "POST", headers = {}, body } = resolveConfig(config, context);
  if (!url) throw new Error("url requis pour http_request");

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({ status: res.status }));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function executeStepSendEmail(config, context) {
  const { to, subject, body } = resolveConfig(config, context);
  const { sendEmail } = await import("../email/email-service.js");
  await sendEmail({ to, subject, html: body });
  return { sent: true, to, subject };
}

async function executeStepVaultWrite(config, context) {
  const { path: notePath, content } = resolveConfig(config, context);
  const { writeNote } = await import("../vault/vault-service.js");
  return writeNote(context.workspaceId, notePath, content);
}

async function executeStepCondition(config, context) {
  const { expression } = resolveConfig(config, context);
  // Évaluation sécurisée : on supporte uniquement des comparaisons simples
  // ex: "42 > 10", "hello == hello", "3 != 5"
  const result = evalSimpleExpression(expression);
  return { result, expression };
}

/**
 * Évalue une expression simple de comparaison (sans eval()).
 * Supporte : ==, !=, >, <, >=, <=
 */
function evalSimpleExpression(expr) {
  if (typeof expr !== "string") return Boolean(expr);
  const ops = [">=", "<=", "!=", "==", ">", "<"];
  for (const op of ops) {
    const idx = expr.indexOf(op);
    if (idx === -1) continue;
    const left = expr.slice(0, idx).trim();
    const right = expr.slice(idx + op.length).trim();
    const l = isNaN(Number(left)) ? left : Number(left);
    const r = isNaN(Number(right)) ? right : Number(right);
    switch (op) {
      case "==": return l == r;
      case "!=": return l != r;
      case ">":  return l > r;
      case "<":  return l < r;
      case ">=": return l >= r;
      case "<=": return l <= r;
    }
  }
  // Si expression non reconnue, retourner vrai si non vide
  return Boolean(expr && expr !== "false" && expr !== "0");
}

// ─── Step dispatcher ─────────────────────────────────────────────

export async function executeStep(step, runContext) {
  const start = Date.now();
  try {
    let output;
    switch (step.type) {
      case "agent":        output = await executeStepAgent(step.config, runContext); break;
      case "tool":         output = await executeStepTool(step.config, runContext); break;
      case "http_request": output = await executeStepHttpRequest(step.config, runContext); break;
      case "send_email":   output = await executeStepSendEmail(step.config, runContext); break;
      case "vault_write":  output = await executeStepVaultWrite(step.config, runContext); break;
      case "condition":    output = await executeStepCondition(step.config, runContext); break;
      default: throw new Error(`Type d'étape inconnu: ${step.type}`);
    }
    return { output, error: null, durationMs: Date.now() - start };
  } catch (err) {
    return { output: null, error: err.message, durationMs: Date.now() - start };
  }
}

// ─── Run automation ───────────────────────────────────────────────

export async function runAutomation(automationId, triggerData = {}, triggeredBy = "manual") {
  const automation = await prisma.automation.findUnique({
    where: { id: automationId },
  });

  if (!automation) throw new Error(`Automation ${automationId} introuvable`);
  if (!automation.isActive) throw new Error("Automation désactivée");

  const workspaceId = automation.workspaceId;

  // Vérifier la concurrence
  const current = runningByWorkspace.get(workspaceId) || 0;
  if (current >= MAX_CONCURRENT_PER_WORKSPACE) {
    throw new Error(`Trop de runs simultanés pour ce workspace (max ${MAX_CONCURRENT_PER_WORKSPACE})`);
  }
  runningByWorkspace.set(workspaceId, current + 1);

  // Créer le run
  const run = await prisma.automationRun.create({
    data: {
      automationId,
      status: "running",
      triggeredBy,
      inputData: JSON.stringify(triggerData),
    },
  });

  // Contexte d'exécution
  const runContext = {
    workspaceId,
    trigger: triggerData,
    steps: {},
  };

  const stepsLog = [];
  let steps;
  let finalStatus = "success";
  let finalError = null;

  try {
    steps = JSON.parse(automation.steps || "[]");

    // Exécution séquentielle avec support conditions
    let currentStepId = steps[0]?.id || null;
    const stepMap = Object.fromEntries(steps.map((s) => [s.id, s]));

    while (currentStepId) {
      const step = stepMap[currentStepId];
      if (!step) break;

      logger.info("[automation-engine] Executing step", {
        automationId,
        runId: run.id,
        stepId: step.id,
        type: step.type,
      });

      const result = await executeStep(step, runContext);

      stepsLog.push({
        stepId: step.id,
        type: step.type,
        name: step.name,
        status: result.error ? "error" : "success",
        output: result.output,
        error: result.error,
        durationMs: result.durationMs,
      });

      // Stocker la sortie pour les templates
      runContext.steps[step.id] = { output: result.output };

      if (result.error) {
        const onError = step.onError || "stop";
        if (onError === "stop") {
          finalStatus = "error";
          finalError = `Step '${step.name}' failed: ${result.error}`;
          break;
        }
        // "continue" → on passe à nextStepId quand même
        if (typeof onError === "string" && onError !== "continue") {
          currentStepId = onError; // goto error handler step
          continue;
        }
      }

      // Navigation selon type condition
      if (step.type === "condition") {
        currentStepId = result.output?.result ? step.thenStepId : step.elseStepId;
      } else {
        currentStepId = step.nextStepId;
      }
    }
  } catch (err) {
    finalStatus = "error";
    finalError = err.message;
    logger.error("[automation-engine] Run failed", err, { automationId, runId: run.id });
  } finally {
    runningByWorkspace.set(workspaceId, Math.max(0, (runningByWorkspace.get(workspaceId) || 1) - 1));
  }

  // Mettre à jour le run
  const finishedRun = await prisma.automationRun.update({
    where: { id: run.id },
    data: {
      status: finalStatus,
      stepsLog: JSON.stringify(stepsLog),
      error: finalError,
      finishedAt: new Date(),
    },
  });

  // Mettre à jour l'automation
  await prisma.automation.update({
    where: { id: automationId },
    data: {
      lastRunAt: new Date(),
      lastRunStatus: finalStatus,
    },
  });

  return finishedRun;
}
