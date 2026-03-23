/**
 * Prompt Loader — Charge le bon prompt système pour un agent et un client.
 * Priorité : prompt custom actif en DB > prompt par défaut.
 */

import { prisma } from "../../src/prisma.js";
import { SYSTEM_PROMPTS } from "./system/defaults.js";

/**
 * Charge le prompt système pour un agent donné.
 * @param {string} agentId - ID de l'agent (ex: "sales-copilot")
 * @param {number} [clientId] - ID du client (pour surcharge)
 * @returns {Promise<string>} - Le prompt système
 */
export async function loadPrompt(agentId, clientId = null) {
  // 1. Chercher un prompt custom actif pour ce client + agent
  if (clientId) {
    const custom = await prisma.agentPrompt.findFirst({
      where: {
        agentId,
        clientId,
        isActive: true
      },
      orderBy: { version: "desc" },
      select: { systemPrompt: true }
    });

    if (custom) return custom.systemPrompt;
  }

  // 2. Chercher un prompt custom global (pas de client) pour cet agent
  const global = await prisma.agentPrompt.findFirst({
    where: {
      agentId,
      clientId: null,
      isActive: true
    },
    orderBy: { version: "desc" },
    select: { systemPrompt: true }
  });

  if (global) return global.systemPrompt;

  // 3. Fallback vers le prompt par défaut codé en dur
  return SYSTEM_PROMPTS[agentId] || SYSTEM_PROMPTS["commercial"];
}

/**
 * Injecte des variables dans un template de prompt.
 * @param {string} template - Prompt avec placeholders {variable}
 * @param {Object} vars - Variables à injecter
 * @returns {string}
 */
export function interpolatePrompt(template, vars = {}) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    const stringValue = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    result = result.replaceAll(`{${key}}`, stringValue);
  }
  return result;
}
