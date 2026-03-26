/**
 * Pipeline Executor — Orchestre l'exécution séquentielle des sous-agents.
 *
 * Pipeline : File → Sellsy → Web → (loop si high mode)
 * Les sous-agents du même type s'exécutent en parallèle.
 */

import { FileHelperSubAgent } from "./file-helper.js";
import { SellsyActionSubAgent } from "./sellsy-action.js";
import { WebActionSubAgent } from "./web-action.js";
import { PipelineDiagnosticSubAgent } from "./pipeline-diagnostic.js";
import { SalesAnalysisSubAgent } from "./sales-analysis.js";
import { SalesStrategySubAgent } from "./sales-strategy.js";
import { SalesWriterSubAgent } from "./sales-writer.js";
import { KnowledgeSubAgent } from "./knowledge.js";
import { CRMSearchSubAgent } from "./crm-search.js";
import { CRMActionSubAgent } from "./crm-action.js";
import { TaskListSubAgent } from "./task-list.js";
import { TaskCreatorSubAgent } from "./task-creator.js";
import { ImageReaderSubAgent } from "./image-reader.js";
import { AdminPlatformSubAgent } from "./admin-platform.js";

/**
 * Execute the sub-agent pipeline.
 *
 * @param {Object} params
 * @param {Array} params.plan - Sub-agent tasks from the main agent's plan
 *   Each task: { type: 'file'|'sellsy'|'web', instruction: string, [url]: string }
 * @param {Object} params.provider - LLM provider instance
 * @param {Object} params.toolContext - { sellsyClient, tavilyApiKey, uploadedFiles }
 * @param {string} params.thinkingMode - 'low' | 'high'
 * @param {string} [params.globalContext] - Initial global context
 * @param {Function} [params.onEvent] - SSE event callback
 * @returns {Promise<{ results: Array, globalContext: string, totalTokensInput: number, totalTokensOutput: number }>}
 */
export async function executePipeline({
  plan,
  provider,
  toolContext,
  thinkingMode = "low",
  globalContext = "",
  onEvent = null
}) {
  const maxSubAgents = thinkingMode === "high" ? 10 : 3;
  const maxLoops = thinkingMode === "high" ? 3 : 1;

  const allResults = [];
  let currentContext = globalContext;
  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  let subAgentCount = 0;

  for (let loop = 0; loop < maxLoops; loop++) {
    if (loop > 0 && onEvent) {
      onEvent({ type: "pipeline_loop", loop: loop + 1 });
    }

    // Phase 1: File sub-agents
    const fileTasks = plan.filter((t) => t.type === "file");
    if (fileTasks.length > 0 && subAgentCount < maxSubAgents) {
      const tasksToRun = fileTasks.slice(0, maxSubAgents - subAgentCount);
      const fileResults = await _runSubAgentPhase("file", tasksToRun, provider, toolContext, currentContext, thinkingMode, onEvent);
      allResults.push(...fileResults.results);
      currentContext = _enrichContext(currentContext, fileResults.results, "Fichiers analysés");
      totalTokensInput += fileResults.tokensInput;
      totalTokensOutput += fileResults.tokensOutput;
      subAgentCount += tasksToRun.length;
    }

    // Phase 2: Sellsy/Analysis sub-agents
    const analysisTypes = ["sellsy", "pipeline-diagnostic", "sales-analysis"];
    for (const anType of analysisTypes) {
      const tasks = plan.filter((t) => t.type === anType);
      if (tasks.length > 0 && subAgentCount < maxSubAgents) {
        const tasksToRun = tasks.slice(0, maxSubAgents - subAgentCount);
        const results = await _runSubAgentPhase(anType, tasksToRun, provider, toolContext, currentContext, thinkingMode, onEvent);
        allResults.push(...results.results);
        currentContext = _enrichContext(currentContext, results.results, `Données CRM Sellsy (${anType})`);
        totalTokensInput += results.tokensInput;
        totalTokensOutput += results.tokensOutput;
        subAgentCount += tasksToRun.length;
      }
    }

    // Phase 3: Strategy & Content sub-agents
    const strategyTypes = ["sales-strategy", "sales-writer"];
    for (const sType of strategyTypes) {
      const tasks = plan.filter((t) => t.type === sType);
      if (tasks.length > 0 && subAgentCount < maxSubAgents) {
        const tasksToRun = tasks.slice(0, maxSubAgents - subAgentCount);
        const results = await _runSubAgentPhase(sType, tasksToRun, provider, toolContext, currentContext, thinkingMode, onEvent);
        allResults.push(...results.results);
        currentContext = _enrichContext(currentContext, results.results, `Outputs (${sType})`);
        totalTokensInput += results.tokensInput;
        totalTokensOutput += results.tokensOutput;
        subAgentCount += tasksToRun.length;
      }
    }

    // Phase 4: Web sub-agents
    const webTasks = plan.filter((t) => t.type === "web");
    if (webTasks.length > 0 && subAgentCount < maxSubAgents) {
      const tasksToRun = webTasks.slice(0, maxSubAgents - subAgentCount);
      const webResults = await _runSubAgentPhase("web", tasksToRun, provider, toolContext, currentContext, thinkingMode, onEvent);
      allResults.push(...webResults.results);
      currentContext = _enrichContext(currentContext, webResults.results, "Informations web");
      totalTokensInput += webResults.tokensInput;
      totalTokensOutput += webResults.tokensOutput;
      subAgentCount += tasksToRun.length;
    }

    // In high mode, check if another loop would help
    if (loop < maxLoops - 1 && thinkingMode === "high") {
      // Only loop if there are results that could benefit from re-processing
      const hasGaps = allResults.some((r) => !r.output || r.output.length < 50);
      if (!hasGaps) break;
    }
  }

  return {
    results: allResults,
    globalContext: currentContext,
    totalTokensInput,
    totalTokensOutput
  };
}

/**
 * Run a phase of same-type sub-agents in parallel.
 */
async function _runSubAgentPhase(type, tasks, provider, toolContext, currentContext, thinkingMode, onEvent) {
  const SubAgentClass = {
    file: FileHelperSubAgent,
    sellsy: SellsyActionSubAgent,
    web: WebActionSubAgent,
    "pipeline-diagnostic": PipelineDiagnosticSubAgent,
    "sales-analysis": SalesAnalysisSubAgent,
    "sales-strategy": SalesStrategySubAgent,
    "sales-writer": SalesWriterSubAgent,
    knowledge: KnowledgeSubAgent,
    "crm-search": CRMSearchSubAgent,
    "crm-action": CRMActionSubAgent,
    "task-list": TaskListSubAgent,
    "task-creator": TaskCreatorSubAgent,
    "image-reader": ImageReaderSubAgent,
    "admin-platform": AdminPlatformSubAgent
  }[type];

  if (!SubAgentClass) {
    console.warn(`[Pipeline] Unknown sub-agent type: ${type}`);
    return { results: [], tokensInput: 0, tokensOutput: 0 };
  }

  let tokensInput = 0;
  let tokensOutput = 0;

  const promises = tasks.map(async (task, index) => {
    const agentId = `${type}-${index}`;

    if (onEvent) {
      onEvent({
        type: "sub_agent_start",
        agentId,
        agentName: _getSubAgentLabel(type, index),
        subAgentType: type,
        task: task.instruction?.slice(0, 80) || null,
        operation: _detectOperation(type, task)
      });
    }

    const subAgent = new SubAgentClass({ provider });

    try {
      const result = await subAgent.execute({
        demande: task.instruction,
        contexte: currentContext,
        toolContext,
        thinkingMode,
        onEvent: onEvent ? (evt) => {
          // Rename sub-agent internal event types to the standard pipeline event types
          let mappedType = evt.type;
          if (evt.type === "tool_call") mappedType = "sub_agent_tool_call";
          if (evt.type === "tool_result") mappedType = "sub_agent_tool_result";
          onEvent({ ...evt, type: mappedType, agentId, agentName: _getSubAgentLabel(type, index) });
        } : null
      });

      if (onEvent) {
        onEvent({
          type: "sub_agent_end",
          agentId,
          agentName: _getSubAgentLabel(type, index),
          subAgentType: type,
          success: true,
          summary: result.output?.slice(0, 200) || ""
        });
      }

      return result;
    } catch (error) {
      console.error(`[Pipeline] Sub-agent ${agentId} error:`, error.message);

      if (onEvent) {
        onEvent({
          type: "sub_agent_end",
          agentId,
          agentName: _getSubAgentLabel(type, index),
          subAgentType: type,
          success: false,
          error: error.message
        });
      }

      return {
        demande: task.instruction,
        contexte: currentContext,
        think: `Erreur: ${error.message}`,
        output: "",
        sources: [],
        tokensInput: 0,
        tokensOutput: 0
      };
    }
  });

  const results = await Promise.all(promises);

  for (const r of results) {
    tokensInput += r.tokensInput || 0;
    tokensOutput += r.tokensOutput || 0;
  }

  return { results, tokensInput, tokensOutput };
}

/**
 * Enrich the global context with sub-agent results.
 */
function _enrichContext(currentContext, results, sectionTitle) {
  if (!results?.length) return currentContext;

  const newInfo = results
    .map((r) => {
      if (!r.output) return null;
      const val = typeof r.output === "string" ? r.output.trim() : JSON.stringify(r.output);
      return val ? val : null;
    })
    .filter(Boolean)
    .join("\n\n");

  if (!newInfo.trim()) return currentContext;

  return `${currentContext}\n\n--- ${sectionTitle} ---\n${newInfo}`;
}

/**
 * Human-readable label for a sub-agent.
 */
function _getSubAgentLabel(type, index) {
  const labels = {
    file: "Analyse Fichier",
    sellsy: "Recherche Sellsy",
    web: "Recherche Web",
    "pipeline-diagnostic": "Diagnostic Pipeline",
    "sales-analysis": "Analyse Commerciale",
    "sales-strategy": "Stratégie & Priorités",
    "sales-writer": "Rédaction Commerciale",
    knowledge: "Base de Connaissance",
    "crm-search": "Recherche CRM",
    "crm-action": "Action CRM",
    "task-list": "Liste Tâches",
    "task-creator": "Créateur Tâche",
    "image-reader": "Analyse Image",
    "admin-platform": "Statistiques Plateforme"
  };
  const base = labels[type] || type;
  return index > 0 ? `${base} #${index + 1}` : base;
}

/**
 * Detect the primary operation type from a task instruction.
 * Used by the widget to show distinct animations.
 */
function _detectOperation(type, task) {
  const instr = (task.instruction || "").toLowerCase();
  if (type === "file") {
    return /genere|créer|create|write|export|rapport|report/.test(instr) ? "generate" : "read";
  }
  if (type === "web") {
    return /scrape|lire|read|page|url|http/.test(instr) ? "scrape" : "search";
  }
  if (type === "sellsy" || type === "crm-search") {
    if (/crée|create|ajoute|add|note|activite/.test(instr)) return "create";
    if (/modifie|update|met.a.jour|change/.test(instr)) return "update";
    return "read";
  }
  if (type === "crm-action") {
    if (/crée|create|ajoute|add/.test(instr)) return "create";
    if (/modifie|update|supprime|delete/.test(instr)) return "update";
    return "action";
  }
  if (type === "task-creator") {
    return /crée|create|rappelle|remind/.test(instr) ? "create" : "action";
  }
  if (type === "image-reader") {
    return "read";
  }
  if (type === "admin-platform") {
    return "read";
  }
  return "read";
}
