/**
 * Semantic Memory — Stockage et recherche vectorielle (pgvector).
 *
 * Utilise l'extension pgvector sur Supabase pour la recherche par similarité cosinus.
 * Requiert CREATE EXTENSION IF NOT EXISTS vector dans la DB.
 *
 * Format d'embedding compatible : vector(1536) — OpenAI text-embedding-3-small.
 */

import { prisma } from "../prisma.js";

/**
 * Stocke un nouveau souvenir sémantique.
 * @param {object} params
 * @param {string} params.content - Texte brut du souvenir
 * @param {string|null} [params.summary] - Résumé optionnel
 * @param {number[]|null} [params.embedding] - Vecteur d'embedding (1536 dimensions)
 * @param {string|null} [params.workspaceId]
 * @param {number|null} [params.userId]
 * @param {string|null} [params.agentId]
 * @param {string|null} [params.conversationId]
 * @returns {Promise<object>} - La ligne créée
 */
export async function storeMemory({ content, summary = null, embedding = null, workspaceId = null, userId = null, agentId = null, conversationId = null }) {
  if (embedding) {
    // Insertion avec embedding via raw SQL (Prisma ne supporte pas vector nativement)
    const vectorStr = `[${embedding.join(",")}]`;
    const result = await prisma.$queryRaw`
      INSERT INTO memory_semantic (content, summary, embedding, workspace_id, user_id, agent_id, conversation_id, created_at)
      VALUES (${content}, ${summary}, ${vectorStr}::vector, ${workspaceId}, ${userId}, ${agentId}, ${conversationId}, NOW())
      RETURNING id, content, summary, workspace_id, created_at
    `;
    return result[0];
  }

  // Insertion sans embedding
  return prisma.memorySemantic.create({
    data: { content, summary, workspaceId, userId, agentId, conversationId },
  });
}

/**
 * Recherche les N souvenirs les plus similaires à un embedding query.
 * @param {object} params
 * @param {number[]} params.queryEmbedding - Vecteur query (1536 dimensions)
 * @param {string} params.workspaceId - Isolation tenant obligatoire
 * @param {number} [params.limit=5]
 * @param {number} [params.minScore=0.7] - Score cosinus minimum (0-1)
 * @returns {Promise<Array<{ id, content, summary, score }>>}
 */
export async function searchSimilar({ queryEmbedding, workspaceId, limit = 5, minScore = 0.7 }) {
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  const results = await prisma.$queryRaw`
    SELECT
      id,
      content,
      summary,
      1 - (embedding <=> ${vectorStr}::vector) AS score
    FROM memory_semantic
    WHERE workspace_id = ${workspaceId}
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> ${vectorStr}::vector) >= ${minScore}
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `;
  return results;
}

/**
 * Supprime les vieux souvenirs d'un workspace (politique d'oubli).
 * @param {string} workspaceId
 * @param {number} [olderThanDays=90]
 * @returns {Promise<number>} - Nombre de lignes supprimées
 */
export async function forgetOldMemories(workspaceId, olderThanDays = 90) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000);
  const result = await prisma.memorySemantic.deleteMany({
    where: {
      workspaceId,
      createdAt: { lt: cutoff },
    },
  });
  return result.count;
}

/**
 * Compte les souvenirs d'un workspace.
 * @param {string} workspaceId
 * @returns {Promise<number>}
 */
export async function countMemories(workspaceId) {
  return prisma.memorySemantic.count({ where: { workspaceId } });
}
