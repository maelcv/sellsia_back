/**
 * Memory Manager — Gestion de la mémoire de session / historique de conversation.
 * Persiste les conversations et messages en base.
 */

import { prisma } from "../../src/prisma.js";
import crypto from "crypto";

/**
 * Crée une nouvelle conversation.
 * @param {number} userId
 * @param {string} agentId
 * @param {Object} pageContext
 * @param {string|null} tenantId - Tenant d'appartenance (null pour super-admin)
 * @returns {Promise<string>} - ID de la conversation
 */
export async function createConversation(userId, agentId, pageContext = {}, tenantId = null) {
  const id = crypto.randomUUID();

  await prisma.conversation.create({
    data: {
      id,
      userId,
      agentId: agentId || null,
      title: null,
      contextType: pageContext?.type || (pageContext?.channel === "whatsapp" ? "whatsapp" : pageContext?.channel === "dashboard" ? "dashboard" : "generic"),
      contextEntityId: pageContext?.entityId || null,
      contextUrl: pageContext?.url || null,
      tenantId: tenantId || null // isolation multi-tenant
    }
  });

  return id;
}

/**
 * Récupère ou crée une conversation pour le contexte donné.
 * Réutilise une conversation existante si même utilisateur + même contexte + < 30 min.
 */
export async function getOrCreateConversation(userId, agentId, pageContext = {}, tenantId = null) {
  // Une conversation = une session de chat active.
  // Sans conversationId explicite fourni par le client, on en cree toujours une nouvelle.
  return createConversation(userId, agentId, pageContext, tenantId);
}

function buildConversationTitleFromUserMessage(content = "") {
  const cleaned = String(content || "")
    .replace(/\[Fichiers joints:[^\]]+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "Nouvelle conversation";
  if (cleaned.length <= 72) return cleaned;
  return `${cleaned.slice(0, 69).trimEnd()}...`;
}

/**
 * Ajoute un message à une conversation.
 */
export async function addMessage(conversationId, { role, content, agentId, tokensInput = 0, tokensOutput = 0, provider, model, sourcesUsed = null }) {
  const serializedSources = sourcesUsed ? JSON.stringify(sourcesUsed) : null;
  // Sub-agent IDs (e.g. "sellsy-0", "web-1") don't exist in the agents table — use NULL for them
  const validAgentIds = new Set(["commercial", "directeur", "technicien"]);
  const safeAgentId = agentId && validAgentIds.has(agentId) ? agentId : null;

  const result = await prisma.message.create({
    data: {
      conversationId,
      role,
      content,
      agentId: safeAgentId,
      tokensInput,
      tokensOutput,
      provider: provider || null,
      model: model || null,
      sourcesJson: serializedSources
    }
  });

  if (role === "user") {
    const newTitle = buildConversationTitleFromUserMessage(content);
    // COALESCE(NULLIF(title, ''), ?) — only set title if it's currently NULL or empty
    await prisma.$executeRaw`
      UPDATE conversations
      SET title = COALESCE(NULLIF(title, ''), ${newTitle})
      WHERE id = ${conversationId}
    `;
  }

  // MAJ updated_at de la conversation
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() }
  });

  return result.id;
}

/**
 * Récupère l'historique d'une conversation (pour envoyer au LLM).
 * @param {string} conversationId
 * @param {number} [limit=20] - Nombre de messages max
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function getConversationHistory(conversationId, limit = 20) {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    select: { role: true, content: true },
    orderBy: { createdAt: "asc" },
    take: limit
  });
  return rows;
}

/**
 * Récupère les dernières conversations d'un utilisateur (pour le widget).
 * @param {number} userId
 * @param {number} [limit=10]
 */
export async function getRecentConversations(userId, limit = 10) {
  const rows = await prisma.$queryRaw`
    SELECT c.id, c.title as "topic", c.context_type as "contextType", c.agent_id as "agentId",
            a.name as "agentName",
            c.started_at as "startedAt", c.updated_at as "updatedAt",
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) as "messageCount",
            (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) as "lastMessage",
            (SELECT m.agent_id FROM messages m WHERE m.conversation_id = c.id AND m.role = 'assistant' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) as "lastAssistantAgentId",
            (SELECT ag.name FROM messages m LEFT JOIN agents ag ON ag.id = m.agent_id WHERE m.conversation_id = c.id AND m.role = 'assistant' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) as "lastAssistantAgentName"
     FROM conversations c
     LEFT JOIN agents a ON a.id = c.agent_id
     WHERE c.user_id = ${userId}
     ORDER BY c.updated_at DESC
     LIMIT ${limit}
  `;
  return rows;
}

/**
 * Récupère les messages d'une conversation.
 */
export async function getConversationMessages(conversationId, userId) {
  // Vérifier que la conversation appartient à l'utilisateur
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true }
  });

  if (!conv) return null;

  const rows = await prisma.message.findMany({
    where: { conversationId },
    select: {
      id: true,
      role: true,
      content: true,
      agentId: true,
      tokensInput: true,
      tokensOutput: true,
      provider: true,
      model: true,
      createdAt: true,
      sourcesJson: true
    },
    orderBy: { createdAt: "asc" }
  });

  return rows.map((row) => {
    let sourcesUsed = null;
    if (row.sourcesJson) {
      try {
        sourcesUsed = JSON.parse(row.sourcesJson);
      } catch {
        sourcesUsed = null;
      }
    }

    return {
      id: row.id,
      role: row.role,
      content: row.content,
      agentId: row.agentId,
      tokensInput: row.tokensInput,
      tokensOutput: row.tokensOutput,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt,
      sourcesUsed
    };
  });
}
