/**
 * Automation Engine — Moteur d'exécution des automations.
 *
 * Deux modes d'exécution :
 *  1. DAG (nouveau) — lit `definitionJson` : { nodes, edges }
 *     Utilisé par les workflows créés via le Visual Builder.
 *  2. Legacy (séquentiel) — lit `steps[]`
 *     Utilisé par les automations créées avant le Visual Builder.
 *
 * Point d'entrée unique : runAutomation(automationId, triggerData, triggeredBy)
 *   → route automatiquement vers runAutomationFromDag ou runAutomationLegacy
 *
 * Résolution de variables :
 *  - {{trigger.data}}              → payload du trigger
 *  - {{trigger.data.field}}        → champ du payload
 *  - {{node_XYZ.output}}           → output complet d'un nœud (DAG)
 *  - {{node_XYZ.output.field}}     → champ d'un output (DAG)
 *  - {{step_{id}.output}}          → output d'une étape (legacy)
 *  - {{now}} / {{date}} / {{workspaceId}}
 *
 * Concurrence : max 3 runs simultanés par workspace.
 */

import { prisma }  from "../../prisma.js";
import { logger }  from "../../lib/logger.js";
import { getBrick } from "../../bricks/registry.js";

const MAX_CONCURRENT_PER_WORKSPACE = 3;
const runningByWorkspace = new Map(); // workspaceId → count

function parseTriggeredByUserId(triggeredBy) {
  const raw = String(triggeredBy || "");
  const match = raw.match(/user:(\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function resolveExecutionIdentity(automation, triggeredBy) {
  const triggeredByUserId = parseTriggeredByUserId(triggeredBy);
  const userId = triggeredByUserId || automation.ownerId || null;

  if (!userId) {
    return { userId: null, userRole: null };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  return {
    userId,
    userRole: user?.role || null,
  };
}

// ─── Template resolver ────────────────────────────────────────────

/**
 * Remplace {{variable}} dans une chaîne avec les valeurs de context.
 */
export function resolveTemplate(str, context) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const k = key.trim();

    if (k === "now")         return new Date().toISOString();
    if (k === "date")        return new Date().toISOString().slice(0, 10);
    if (k === "workspaceId") return context.workspaceId || "";

    // trigger.data or trigger.data.field
    if (k === "trigger.data" || k === "trigger") {
      return JSON.stringify(context.trigger ?? {});
    }
    const triggerFieldMatch = k.match(/^trigger\.data\.(.+)$/);
    if (triggerFieldMatch) {
      const path = triggerFieldMatch[1].split(".");
      let val = context.trigger;
      for (const seg of path) val = val?.[seg];
      return val === undefined ? "" : String(val);
    }

    // DAG: node_XYZ.output or node_XYZ.output.field
    const nodeMatch = k.match(/^node_(.+?)\.output(.*)$/);
    if (nodeMatch) {
      const [, nodeId, rest] = nodeMatch;
      const nodeOutput = context.nodes?.[nodeId]?.output;
      if (nodeOutput === undefined) return "";
      if (!rest) return JSON.stringify(nodeOutput);
      const path = rest.replace(/^\./, "").split(".");
      let val = nodeOutput;
      for (const seg of path) val = val?.[seg];
      return val === undefined ? "" : String(val);
    }

    // Legacy: step_{id}.output or step_{id}.output.field
    const stepMatch = k.match(/^step_(.+?)\.output(.*)$/);
    if (stepMatch) {
      const [, stepId, rest] = stepMatch;
      const stepOutput = context.steps?.[stepId]?.output;
      if (stepOutput === undefined) return "";
      if (!rest) return JSON.stringify(stepOutput);
      const path = rest.replace(/^\./, "").split(".");
      let val = stepOutput;
      for (const seg of path) val = val?.[seg];
      return val === undefined ? "" : String(val);
    }

    return `{{${k}}}`;
  });
}

function resolveConfig(config, context) {
  if (typeof config === "string") return resolveTemplate(config, context);
  if (Array.isArray(config))       return config.map((v) => resolveConfig(v, context));
  if (config && typeof config === "object") {
    const out = {};
    for (const [k, v] of Object.entries(config)) {
      out[k] = resolveConfig(v, context);
    }
    return out;
  }
  return config;
}

// ─── DAG Executor ─────────────────────────────────────────────────

/**
 * Exécute un nœud via son brick.
 * Retourne { output, error, durationMs }
 */
async function executeNode(node, runContext) {
  const start = Date.now();
  const brick = getBrick(node.brickId);

  if (!brick) {
    return {
      output: null,
      error:  `Brique inconnue: ${node.brickId}`,
      durationMs: Date.now() - start,
    };
  }

  try {
    const resolvedInputs = resolveConfig(node.config || {}, runContext);

    const context = {
      workspaceId: runContext.workspaceId,
      userId:      runContext.userId || null,
      runId:       runContext.runId  || null,
    };

    const output = await brick.execute(resolvedInputs, context);
    return { output, error: null, durationMs: Date.now() - start };
  } catch (err) {
    return { output: null, error: err.message, durationMs: Date.now() - start };
  }
}

/**
 * Moteur DAG — parse definitionJson et exécute les nœuds.
 */
async function runAutomationFromDag(automation, triggerData, triggeredBy) {
  const workspaceId = automation.workspaceId;
  const executionIdentity = await resolveExecutionIdentity(automation, triggeredBy);

  // Créer le run
  const run = await prisma.automationRun.create({
    data: {
      automationId: automation.id,
      status:       "running",
      triggeredBy,
      inputData:    JSON.stringify(triggerData),
    },
  });

  // Contexte d'exécution
  const runContext = {
    workspaceId,
    userId:  executionIdentity.userId,
    userRole: executionIdentity.userRole,
    runId:   run.id,
    trigger: triggerData,
    nodes:   {}, // nodeId → { output }
  };

  const stepsLog    = [];
  let finalStatus   = "success";
  let finalError    = null;

  try {
    const { nodes, edges } = JSON.parse(automation.definitionJson);

    if (!Array.isArray(nodes) || !nodes.length) {
      throw new Error("Workflow vide : aucun nœud défini");
    }

    // Construire la map nœuds + adjacency list (source → [target])
    const nodeMap  = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const children = {}; // nodeId → [childId]
    const parents  = {}; // nodeId → [parentId]
    for (const node of nodes) {
      children[node.id] = [];
      parents[node.id]  = [];
    }
    for (const edge of (edges || [])) {
      (children[edge.source] ||= []).push(edge.target);
      (parents[edge.target]  ||= []).push(edge.source);

      // Gérer les edges avec handle (true/false pour condition)
      if (edge.sourceHandle === "true"  && nodeMap[edge.source]) {
        nodeMap[edge.source]._trueTarget  = edge.target;
      }
      if (edge.sourceHandle === "false" && nodeMap[edge.source]) {
        nodeMap[edge.source]._falseTarget = edge.target;
      }
    }

    // Trouver le nœud de départ (trigger = pas de parents)
    const startNodes = nodes.filter((n) => (parents[n.id] || []).length === 0);
    if (!startNodes.length) {
      throw new Error("Aucun nœud de départ (trigger) trouvé");
    }

    // Exécution séquentielle avec BFS depuis le(s) trigger(s)
    const queue      = [...startNodes.map((n) => n.id)];
    const visited    = new Set();
    const completed  = new Set();

    while (queue.length) {
      const nodeId = queue.shift();
      if (visited.has(nodeId) || !nodeMap[nodeId]) continue;

      // Attendre que tous les parents soient complétés (join pour branches parallèles)
      const nodeParents = parents[nodeId] || [];
      if (!nodeParents.every((p) => completed.has(p))) {
        queue.push(nodeId); // Remettre en attente
        continue;
      }

      visited.add(nodeId);
      const node = nodeMap[nodeId];

      logger.info("[automation-engine] Executing node", {
        automationId: automation.id,
        runId:        run.id,
        nodeId,
        brickId:      node.brickId,
      });

      const result = await executeNode(node, runContext);

      stepsLog.push({
        stepId:     nodeId,
        type:       node.brickId,
        name:       node.name || nodeId,
        status:     result.error ? "error" : "success",
        output:     result.output,
        error:      result.error,
        durationMs: result.durationMs,
      });

      runContext.nodes[nodeId] = { output: result.output };
      completed.add(nodeId);

      if (result.error) {
        const onError = node.onError || "stop";
        if (onError === "stop") {
          finalStatus = "error";
          finalError  = `Node '${node.name || nodeId}' failed: ${result.error}`;
          break;
        }
        // "continue" → on ajoute quand même les enfants
      }

      // Naviguer vers les enfants
      if (node.brickId === "logic:condition" && result.output) {
        const nextId = result.output.result
          ? node._trueTarget
          : node._falseTarget;
        if (nextId) queue.push(nextId);
      } else {
        for (const childId of (children[nodeId] || [])) {
          queue.push(childId);
        }
      }
    }
  } catch (err) {
    finalStatus = "error";
    finalError  = err.message;
    logger.error("[automation-engine] DAG run failed", err, {
      automationId: automation.id,
      runId:        run.id,
    });
  } finally {
    runningByWorkspace.set(
      workspaceId,
      Math.max(0, (runningByWorkspace.get(workspaceId) || 1) - 1)
    );
  }

  return finalizeRun(run.id, automation.id, finalStatus, finalError, stepsLog);
}

// ─── Legacy Executor ──────────────────────────────────────────────

async function executeStepLegacy(step, runContext) {
  const start = Date.now();
  try {
    let output;

    // Mapper les anciens types vers les briques
    const brickId = {
      http_request: "action:http_request",
      send_email:   "action:send_email",
      vault_write:  "action:vault_write",
      condition:    "logic:condition",
    }[step.type];

    if (brickId) {
      const brick = getBrick(brickId);
      if (brick) {
        const resolvedConfig = resolveConfig(step.config || {}, runContext);
        output = await brick.execute(resolvedConfig, {
          workspaceId: runContext.workspaceId,
          userId:      runContext.userId || null,
          userRole:    runContext.userRole || null,
          runId:       null,
        });
      } else {
        throw new Error(`Brique introuvable pour type legacy: ${step.type}`);
      }
    } else if (step.type === "agent") {
      output = await executeStepAgentLegacy(step.config, runContext);
    } else if (step.type === "tool") {
      output = await executeStepToolLegacy(step.config, runContext);
    } else {
      throw new Error(`Type d'étape inconnu: ${step.type}`);
    }

    return { output, error: null, durationMs: Date.now() - start };
  } catch (err) {
    return { output: null, error: err.message, durationMs: Date.now() - start };
  }
}

async function executeStepAgentLegacy(config, context) {
  const { agentId, prompt } = resolveConfig(config, context);
  if (!agentId) throw new Error("agentId requis pour l'étape agent");
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } });
  if (!agent) throw new Error(`Agent ${agentId} introuvable`);
  return { agentId, prompt, result: `[Agent ${agent.name} exécuté avec: ${prompt}]` };
}

async function executeStepToolLegacy(config, context) {
  const { toolName, params } = resolveConfig(config, context);
  const { ALL_TOOLS } = await import("../../tools/mcp/tools.js");
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Outil inconnu: ${toolName}`);
  return tool.execute(params || {}, { tenantId: context.workspaceId, isAdmin: false });
}

async function runAutomationLegacy(automation, triggerData, triggeredBy) {
  const workspaceId = automation.workspaceId;
  const executionIdentity = await resolveExecutionIdentity(automation, triggeredBy);

  const run = await prisma.automationRun.create({
    data: {
      automationId: automation.id,
      status:       "running",
      triggeredBy,
      inputData:    JSON.stringify(triggerData),
    },
  });

  const runContext = {
    workspaceId,
    userId: executionIdentity.userId,
    userRole: executionIdentity.userRole,
    trigger: triggerData,
    steps: {},
  };
  const stepsLog   = [];
  let finalStatus  = "success";
  let finalError   = null;

  try {
    const steps   = JSON.parse(automation.steps || "[]");
    let currentStepId = steps[0]?.id || null;
    const stepMap = Object.fromEntries(steps.map((s) => [s.id, s]));

    while (currentStepId) {
      const step = stepMap[currentStepId];
      if (!step) break;

      const result = await executeStepLegacy(step, runContext);

      stepsLog.push({
        stepId:     step.id,
        type:       step.type,
        name:       step.name,
        status:     result.error ? "error" : "success",
        output:     result.output,
        error:      result.error,
        durationMs: result.durationMs,
      });

      runContext.steps[step.id] = { output: result.output };

      if (result.error) {
        const onError = step.onError || "stop";
        if (onError === "stop") {
          finalStatus = "error";
          finalError  = `Step '${step.name}' failed: ${result.error}`;
          break;
        }
        if (typeof onError === "string" && onError !== "continue") {
          currentStepId = onError;
          continue;
        }
      }

      if (step.type === "condition") {
        currentStepId = result.output?.result ? step.thenStepId : step.elseStepId;
      } else {
        currentStepId = step.nextStepId;
      }
    }
  } catch (err) {
    finalStatus = "error";
    finalError  = err.message;
  } finally {
    runningByWorkspace.set(
      workspaceId,
      Math.max(0, (runningByWorkspace.get(workspaceId) || 1) - 1)
    );
  }

  return finalizeRun(run.id, automation.id, finalStatus, finalError, stepsLog);
}

// ─── Finalize run ─────────────────────────────────────────────────

async function finalizeRun(runId, automationId, status, error, stepsLog) {
  const finishedRun = await prisma.automationRun.update({
    where: { id: runId },
    data: {
      status,
      stepsLog:   JSON.stringify(stepsLog),
      error,
      finishedAt: new Date(),
    },
  });

  await prisma.automation.update({
    where: { id: automationId },
    data: {
      lastRunAt:     new Date(),
      lastRunStatus: status,
    },
  });

  return finishedRun;
}

// ─── Point d'entrée public ────────────────────────────────────────

export async function runAutomation(automationId, triggerData = {}, triggeredBy = "manual") {
  const automation = await prisma.automation.findUnique({ where: { id: automationId } });

  if (!automation)          throw new Error(`Automation ${automationId} introuvable`);
  if (!automation.isActive) throw new Error("Automation désactivée");

  const workspaceId = automation.workspaceId;
  const current     = runningByWorkspace.get(workspaceId) || 0;

  if (current >= MAX_CONCURRENT_PER_WORKSPACE) {
    throw new Error(`Trop de runs simultanés pour ce workspace (max ${MAX_CONCURRENT_PER_WORKSPACE})`);
  }
  runningByWorkspace.set(workspaceId, current + 1);

  // Routage : DAG si definitionJson présent, sinon legacy
  if (automation.definitionJson) {
    return runAutomationFromDag(automation, triggerData, triggeredBy);
  }
  return runAutomationLegacy(automation, triggerData, triggeredBy);
}

