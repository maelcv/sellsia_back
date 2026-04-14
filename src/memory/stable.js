/**
 * Stable Memory — Mémoire persistante long terme (PostgreSQL).
 *
 * Stocke les préférences, contexte métier, politiques et personas
 * par workspace et/ou utilisateur. Données immuables entre sessions.
 */

import { prisma } from "../prisma.js";

/**
 * Lit une valeur de mémoire stable.
 * @param {object} params
 * @param {string} params.key
 * @param {string|null} [params.workspaceId]
 * @param {number|null} [params.userId]
 * @returns {Promise<string|null>}
 */
export async function getStableMemory({ key, workspaceId = null, userId = null }) {
  const entry = await prisma.memoryStable.findFirst({
    where: {
      key,
      workspaceId: workspaceId || null,
      userId: userId || null,
      isActive: true,
    },
    select: { value: true },
  });
  return entry?.value || null;
}

/**
 * Écrit ou met à jour une valeur de mémoire stable.
 * @param {object} params
 * @param {string} params.key
 * @param {string} params.value
 * @param {string} params.type - MemoryStableType enum value
 * @param {string|null} [params.workspaceId]
 * @param {number|null} [params.userId]
 * @returns {Promise<object>}
 */
export async function setStableMemory({ key, value, type, workspaceId = null, userId = null }) {
  return prisma.memoryStable.upsert({
    where: {
      workspaceId_userId_key: {
        workspaceId: workspaceId || null,
        userId: userId || null,
        key,
      },
    },
    update: { value, type, isActive: true },
    create: { key, value, type, workspaceId, userId },
  });
}

/**
 * Charge toutes les mémoires stables d'un workspace (pour enrichir le contexte agent).
 * @param {string} workspaceId
 * @param {string|null} [type] - Filtrer par type (optionnel)
 * @returns {Promise<Array<{ key: string, value: string, type: string }>>}
 */
export async function loadWorkspaceMemory(workspaceId, type = null) {
  const where = {
    workspaceId,
    isActive: true,
    ...(type ? { type } : {}),
  };
  const entries = await prisma.memoryStable.findMany({
    where,
    select: { key: true, value: true, type: true },
  });
  return entries;
}

/**
 * Formate les mémoires stables en bloc de contexte pour injection dans les prompts.
 * @param {string} workspaceId
 * @returns {Promise<string>}
 */
export async function buildStableContext(workspaceId) {
  const memories = await loadWorkspaceMemory(workspaceId);
  if (!memories.length) return "";

  const grouped = memories.reduce((acc, m) => {
    if (!acc[m.type]) acc[m.type] = [];
    acc[m.type].push(`${m.key}: ${m.value}`);
    return acc;
  }, {});

  const lines = [];
  for (const [type, items] of Object.entries(grouped)) {
    lines.push(`## ${type.toUpperCase()}`);
    lines.push(...items);
  }

  return `\n\n--- CONTEXTE MÉMOIRE ---\n${lines.join("\n")}\n---`;
}
