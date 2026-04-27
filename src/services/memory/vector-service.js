/**
 * Vector Service — Embedding generation and semantic search via pgvector.
 *
 * Uses OpenAI text-embedding-3-small (1536 dims) when the user's provider
 * exposes an OpenAI-compatible /embeddings endpoint (openai-cloud, openrouter-cloud).
 * Falls back gracefully when embeddings are unavailable.
 *
 * pgvector must be enabled on the DB: CREATE EXTENSION IF NOT EXISTS vector;
 */

import { prisma, Prisma } from "../../prisma.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

/**
 * Generate an embedding vector for `text` using the provider's API key.
 * Returns null on failure — callers must handle gracefully.
 *
 * @param {string} text
 * @param {{ apiKey: string; baseUrl?: string; providerName?: string }} provider
 * @returns {Promise<number[] | null>}
 */
export async function generateEmbedding(text, provider) {
  if (!provider?.apiKey || !text?.trim()) return null;

  // Only attempt embeddings for OpenAI-compatible endpoints
  const isCompatible =
    provider.providerName === "openai" ||
    (provider.baseUrl || "").includes("openai.com") ||
    (provider.baseUrl || "").includes("openrouter.ai");

  if (!isCompatible) return null;

  const baseUrl = provider.baseUrl?.replace(/\/$/, "") || "https://api.openai.com/v1";

  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000), // ~2000 tokens max
        dimensions: EMBEDDING_DIMS,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

/**
 * Search MemorySemantic records by vector similarity within a workspace.
 * Falls back to an empty array if pgvector is unavailable.
 *
 * @param {string} workspaceId
 * @param {number[]} queryEmbedding
 * @param {number} limit
 * @returns {Promise<Array<{ content: string; summary: string | null; userId: number | null; agentId: string | null }>>}
 */
export async function searchSimilarDocs(workspaceId, queryEmbedding, limit = 5, allowedUserIds = []) {
  if (!queryEmbedding || queryEmbedding.length === 0) return [];

  try {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    
    // Si allowedUserIds est vide, on ne retourne rien (sécurité par défaut)
    // Sauf si on veut autoriser tous les docs du workspace (mais ici on veut restreindre)
    if (allowedUserIds.length === 0) return [];

    const rows = await prisma.$queryRaw`
      SELECT content, summary, user_id AS "userId", agent_id AS "agentId"
      FROM memory_semantic
      WHERE workspace_id = ${workspaceId}
        AND user_id IN (${Prisma.join(allowedUserIds)})
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `;
    return rows;
  } catch (err) {
    console.warn("[searchSimilarDocs] Error:", err.message);
    return [];
  }
}

/**
 * Index a document into MemorySemantic.
 * Skips silently if embedding generation fails.
 *
 * @param {{ content: string; summary?: string; workspaceId?: string; userId?: number; agentId?: string; conversationId?: string }} doc
 * @param {object} provider - AI provider instance with apiKey
 * @returns {Promise<void>}
 */
export async function indexDocument(doc, provider) {
  const text = doc.summary || doc.content || "";
  const embedding = await generateEmbedding(text, provider);

  try {
    if (embedding) {
      const vectorLiteral = `[${embedding.join(",")}]`;
      await prisma.$executeRaw`
        INSERT INTO memory_semantic (content, summary, embedding, workspace_id, user_id, agent_id, conversation_id, created_at)
        VALUES (
          ${doc.content || ""},
          ${doc.summary ?? null},
          ${vectorLiteral}::vector,
          ${doc.workspaceId ?? null},
          ${doc.userId ?? null},
          ${doc.agentId ?? null},
          ${doc.conversationId ?? null},
          NOW()
        )
      `;
    } else {
      await prisma.memorySemantic.create({
        data: {
          content: doc.content || "",
          summary: doc.summary ?? null,
          workspaceId: doc.workspaceId ?? null,
          userId: doc.userId ?? null,
          agentId: doc.agentId ?? null,
          conversationId: doc.conversationId ?? null,
        },
      });
    }
  } catch {
    // Non-blocking — indexing failure should never break the caller
  }
}
