/**
 * Prompt Loader — Charge le bon prompt système pour un agent et un client.
 * Priorité : Redis cache > prompt custom DB > prompt par défaut JSON.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { prisma } from "../prisma.js";
import { getCachedPrompt, setCachedPrompt } from "../memory/session.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cache mémoire in-process pour les seeds JSON (immuables en runtime)
const seedCache = new Map();

/**
 * Charge le prompt seed depuis un fichier JSON.
 * @param {string} agentId
 * @returns {string|null}
 */
function loadSeedPrompt(agentId) {
  if (seedCache.has(agentId)) return seedCache.get(agentId);
  try {
    const filePath = resolve(__dirname, `defaults/${agentId}.json`);
    const raw = readFileSync(filePath, "utf-8");
    const { systemPrompt } = JSON.parse(raw);
    if (systemPrompt) seedCache.set(agentId, systemPrompt);
    return systemPrompt || null;
  } catch {
    return null;
  }
}

/**
 * Charge le prompt système pour un agent donné.
 * @param {string} agentId - ID de l'agent (ex: "commercial", "directeur")
 * @param {number|null} [clientId] - ID du client (pour surcharge)
 * @param {object} [redisClient] - Client Redis optionnel (injecté pour éviter import circulaire)
 * @returns {Promise<string>}
 */
export async function loadPrompt(agentId, clientId = null) {
  // 1. Redis cache
  const cacheKey = `agent_prompt:${agentId}:${clientId || "global"}`;
  const cached = await getCachedPrompt(cacheKey);
  if (cached) {
    logger.info("cache.hit", { key: cacheKey, layer: "redis" });
    return cached;
  }
  logger.info("cache.miss", { key: cacheKey, layer: "db" });

  // 2. Prompt custom DB (client-specific)
  if (clientId) {
    const custom = await prisma.agentPrompt.findFirst({
      where: { agentId, clientId, isActive: true },
      orderBy: { version: "desc" },
      select: { systemPrompt: true }
    });
    if (custom?.systemPrompt) {
      await setCachedPrompt(cacheKey, custom.systemPrompt);
      return custom.systemPrompt;
    }
  }

  // 3. Prompt custom DB (global)
  const globalPrompt = await prisma.agentPrompt.findFirst({
    where: { agentId, clientId: null, isActive: true },
    orderBy: { version: "desc" },
    select: { systemPrompt: true }
  });
  if (globalPrompt?.systemPrompt) {
    await setCachedPrompt(`agent_prompt:${agentId}:global`, globalPrompt.systemPrompt);
    return globalPrompt.systemPrompt;
  }

  // 4. Fallback JSON seed
  return loadSeedPrompt(agentId) || loadSeedPrompt("commercial");
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

/**
 * Charge les prompts spéciaux de l'orchestrateur depuis le JSON seed.
 * @returns {object}
 */
export function loadOrchestratorPrompts() {
  try {
    const filePath = resolve(__dirname, "defaults/orchestrator.json");
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}
