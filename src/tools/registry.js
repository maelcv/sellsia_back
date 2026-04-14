/**
 * Tool Registry — Point d'entrée central pour tous les tools disponibles.
 *
 * Agrège :
 * - Tools builtin (depuis src/tools/builtin/)
 * - Tools DB-driven (SubAgentDefinition) chargés dynamiquement par workspace
 * - Résolution capability → tools
 * - Formatage pour les différents providers LLM
 */

import { ALL_TOOLS, toOpenAITools, toAnthropicTools, toMistralTools } from "./mcp/tools.js";
import { CAPABILITY_TOOLS } from "./builtin/capability-tool-map.js";

// Index nom → tool object pour lookup rapide
const TOOL_INDEX = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));

/**
 * Résout une liste de noms de capabilities en outils concrets.
 * @param {string[]} capabilityKeys
 * @returns {Array} tools
 */
export function resolveCapabilities(capabilityKeys) {
  const seen = new Set();
  const result = [];
  for (const key of capabilityKeys) {
    const capTools = CAPABILITY_TOOLS[key] || [];
    for (const tool of capTools) {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        result.push(tool);
      }
    }
  }
  return result;
}

/**
 * Retourne tous les tools builtin disponibles.
 * @returns {Array}
 */
export function getAllBuiltinTools() {
  return ALL_TOOLS;
}

/**
 * Cherche un tool par son nom.
 * @param {string} name
 * @returns {object|null}
 */
export function getToolByName(name) {
  return TOOL_INDEX[name] || null;
}

/**
 * Retourne la liste de toutes les capabilities disponibles.
 * @returns {string[]}
 */
export function listCapabilities() {
  return Object.keys(CAPABILITY_TOOLS);
}

/**
 * Formate les tools pour un provider LLM donné.
 * @param {Array} tools - Liste de tool objects
 * @param {string} provider - "anthropic" | "openai" | "mistral" | "ollama"
 * @returns {Array}
 */
export function formatToolsForProvider(tools, provider) {
  switch (provider) {
    case "anthropic":
      return toAnthropicTools(tools);
    case "mistral":
      return toMistralTools(tools);
    case "openai":
    case "ollama":
    default:
      return toOpenAITools(tools);
  }
}

/**
 * Retourne les tools qu'un agent est autorisé à utiliser.
 * Combine allowedTools + allowedSubAgents (legacy) en filtrant les builtin tools.
 * @param {object} agent - Objet agent Prisma
 * @returns {Array}
 */
export function getToolsForAgent(agent) {
  let allowedNames = [];

  try {
    const allowedTools = JSON.parse(agent.allowedTools || "[]");
    allowedNames = [...allowedTools];
  } catch { /* ignore */ }

  try {
    const allowedSubAgents = JSON.parse(agent.allowedSubAgents || "[]");
    allowedNames = [...allowedNames, ...allowedSubAgents];
  } catch { /* ignore */ }

  if (allowedNames.length === 0) return ALL_TOOLS;

  return ALL_TOOLS.filter((t) => allowedNames.includes(t.name));
}
