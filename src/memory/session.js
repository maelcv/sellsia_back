/**
 * Session Memory — Mémoire conversationnelle courte durée.
 *
 * Redis-first avec fallback PostgreSQL transparent.
 * Si Redis est indisponible, les messages sont lus depuis la DB.
 *
 * Schéma des clés Redis :
 *   session:{conversationId}              → messages récents (JSON, TTL 2h)
 *   user_profile:{userId}:{workspaceId}   → profil utilisateur (TTL 5min)
 *   tool_registry:{workspaceId}           → tools DB (TTL 5min)
 */

import { getRedis } from "../cache/redis-client.js";
import { prisma } from "../prisma.js";
import { logger } from "../lib/logger.js";

const TTL = {
  SESSION: 7200,      // 2 heures
  USER_PROFILE: 300,  // 5 minutes
  TOOL_REGISTRY: 300, // 5 minutes
};

// ─────────────────────────────────────────────────────────────────────────────
// Session messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Charge les N derniers messages d'une conversation.
 * Redis-first, fallback Postgres.
 * @param {string} conversationId
 * @param {number} [limit=20]
 * @returns {Promise<Array>}
 */
export async function getSessionMessages(conversationId, limit = 20) {
  const redis = await getRedis();

  if (redis) {
    try {
      const raw = await redis.get(`session:${conversationId}`);
      if (raw) {
        logger.info("cache.hit", { key: `session:${conversationId}`, layer: "redis" });
        const msgs = JSON.parse(raw);
        return msgs.slice(-limit);
      }
      logger.info("cache.miss", { key: `session:${conversationId}`, layer: "redis" });
    } catch { /* fallback */ }
  }

  // Fallback DB
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { role: true, content: true, createdAt: true },
  });
  return messages.reverse();
}

/**
 * Ajoute un message à la session et remet le TTL à jour.
 * @param {string} conversationId
 * @param {{ role: string, content: string }} message
 * @param {number} [maxMessages=50] - Nombre max de messages conservés en Redis
 */
export async function pushSessionMessage(conversationId, message, maxMessages = 50) {
  const redis = await getRedis();
  if (!redis) return;

  try {
    const key = `session:${conversationId}`;
    const raw = await redis.get(key);
    const messages = raw ? JSON.parse(raw) : [];
    messages.push(message);

    // Garder uniquement les N derniers messages
    const trimmed = messages.slice(-maxMessages);
    await redis.set(key, JSON.stringify(trimmed), "EX", TTL.SESSION);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// User profile cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère le profil utilisateur depuis le cache ou la DB.
 * @param {number} userId
 * @param {string} workspaceId
 * @returns {Promise<object|null>}
 */
export async function getUserProfile(userId, workspaceId) {
  const redis = await getRedis();
  const key = `user_profile:${userId}:${workspaceId}`;

  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        logger.info("cache.hit", { key, layer: "redis" });
        return JSON.parse(raw);
      }
      logger.info("cache.miss", { key, layer: "redis" });
    } catch { /* fallback */ }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      workspaceId: true,
      workspace: {
        select: {
          id: true,
          name: true,
          planId: true,
          customAiProvider: true,
        },
      },
    },
  });

  if (user && redis) {
    try {
      await redis.set(key, JSON.stringify(user), "EX", TTL.USER_PROFILE);
    } catch { /* ignore */ }
  }

  return user;
}

/**
 * Invalide le cache d'un profil utilisateur.
 * @param {number} userId
 * @param {string} workspaceId
 */
export async function invalidateUserProfile(userId, workspaceId) {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.del(`user_profile:${userId}:${workspaceId}`);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt cache helpers (utilisés par loader.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lit un prompt depuis le cache Redis.
 * @param {string} cacheKey
 * @returns {Promise<string|null>}
 */
export async function getCachedPrompt(cacheKey) {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    return await redis.get(cacheKey);
  } catch {
    return null;
  }
}

/**
 * Écrit un prompt dans le cache Redis.
 * @param {string} cacheKey
 * @param {string} prompt
 * @param {number} [ttl=600]
 */
export async function setCachedPrompt(cacheKey, prompt, ttl = 600) {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(cacheKey, prompt, "EX", ttl);
  } catch { /* ignore */ }
}

/**
 * Invalide le cache d'un prompt agent.
 * @param {string} agentId
 * @param {string|null} workspaceId
 */
export async function invalidatePromptCache(agentId, workspaceId = null) {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const keys = [
      `agent_prompt:${agentId}:global`,
      workspaceId ? `agent_prompt:${agentId}:${workspaceId}` : null,
    ].filter(Boolean);
    if (keys.length) await redis.del(...keys);
  } catch { /* ignore */ }
}
