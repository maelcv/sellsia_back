/**
 * Context Manager — Gère l'enrichissement du contexte via l'API Sellsy
 * et le chargement des documents de la knowledge base.
 */

import { getSellsyCredentials, getProviderForUser } from "../ai-providers/index.js";
import { SellsyClient, fetchContextData } from "../sellsy/client.js";
import { prisma } from "../prisma.js";
import { generateEmbedding, searchSimilarDocs } from "../services/memory/vector-service.js";

/**
 * Retourne une instance SellsyClient pour un utilisateur (ou null si pas de credentials).
 * Utilisé par le tool-calling pour donner aux agents l'accès à l'API Sellsy.
 * @param {number} userId
 * @returns {Promise<SellsyClient|null>}
 */
export async function getSellsyClient(userId) {
  const credentials = await getSellsyCredentials(userId);
  if (!credentials) return null;
  return new SellsyClient(credentials);
}

function inferEntityIdFromUrl(url = "") {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    const searchKeys = ["id", "opportunityId", "companyId", "contactId", "estimateId", "quoteId"];
    for (const key of searchKeys) {
      const value = parsed.searchParams.get(key);
      if (value) return value;
    }

    const ignored = new Set([
      "companies",
      "company",
      "contacts",
      "contact",
      "opportunities",
      "opportunity",
      "deals",
      "deal",
      "estimates",
      "estimate",
      "quotes",
      "quote",
      "invoices",
      "invoice",
      "details",
      "view",
      "edit",
      "pipeline"
    ]);

    const segments = parsed.pathname.split("/").filter(Boolean).reverse();
    for (const segment of segments) {
      const value = decodeURIComponent(segment);
      const normalized = value.toLowerCase();
      if (ignored.has(normalized)) continue;
      if (/^\d+$/.test(value)) return value;
      if (/^[a-f0-9]{8,}$/i.test(value)) return value;
      if (/^[a-z0-9]{6,}-[a-z0-9-]{2,}$/i.test(value)) return value;
    }
  } catch {
    return "";
  }

  return "";
}

/**
 * Enrichit le contexte avec les données Sellsy réelles.
 * @param {number} userId - ID de l'utilisateur
 * @param {Object} pageContext - { type, entityId, title, url }
 * @returns {Promise<Object>} - Données enrichies
 */
export async function enrichContext(userId, pageContext) {
  const normalizedPageContext = {
    ...(pageContext || {}),
    entityId: pageContext?.entityId || inferEntityIdFromUrl(pageContext?.url || "")
  };

  const credentials = await getSellsyCredentials(userId);

  if (!credentials) {
    return { contextType: normalizedPageContext?.type || "generic", data: null, sellsyConnected: false };
  }

  try {
    const client = new SellsyClient(credentials);
    const contextData = await fetchContextData(client, normalizedPageContext);
    return { ...contextData, sellsyConnected: true };
  } catch (error) {
    console.error("[Context] Sellsy enrichment failed:", error.message);
    return {
      contextType: normalizedPageContext?.type || "generic",
      data: null,
      sellsyConnected: true,
      error: error.message
    };
  }
}

/**
 * Récupère les données pipeline pour l'Executive Copilot.
 * @param {number} userId
 * @returns {Promise<Object>}
 */
export async function enrichWithPipelineData(userId) {
  const credentials = await getSellsyCredentials(userId);
  if (!credentials) return null;

  try {
    const client = new SellsyClient(credentials);
    return await client.getPipelineAnalysis();
  } catch (error) {
    console.error("[Context] Pipeline enrichment failed:", error.message);
    return null;
  }
}

/**
 * Charge les documents pertinents de la knowledge base.
 * Pour l'instant, recherche simple par mots-clés.
 * Pourra être remplacé par du RAG avec embeddings plus tard.
 *
 * @param {string} query - Message utilisateur
 * @param {string} agentId - Agent concerné
 * @param {number} [clientId] - Client pour filtrer les docs
 * @param {number} [limit=3] - Nombre de docs à retourner
 * @returns {Promise<string|null>} - Contenu concaténé des docs pertinents
 */
/**
 * Load knowledge context with strict workspace isolation.
 *
 * A user can only access:
 *   1. Global platform docs (clientId=null AND agentId=null)
 *   2. Docs belonging to users in their workspace (via wsUserIds)
 *   3. Docs linked to the specific agent being used
 *
 * @param {string} query
 * @param {string} agentId
 * @param {number|null} clientId
 * @param {number} limit
 * @param {string|null} workspaceId - If set, restricts search to workspace scope
 */
export async function loadKnowledgeContext(query, agentId, clientId = null, limit = 3, workspaceId = null, requesterId = null) {
  const normalizedQuery = (query || "").toLowerCase();
  const effectiveRequesterId = requesterId ?? clientId;

  // Build allowed clientId list for workspace isolation + rank hierarchy
  let wsUserIds = clientId ? [clientId] : [];
  if (workspaceId) {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: effectiveRequesterId },
        select: { role: true }
      });

      const wsUsers = await prisma.user.findMany({
        where: { workspaceId },
        select: { id: true }
      });
      wsUserIds = wsUsers.map(u => u.id);

      // Platform ADMINs bypass rank check within a workspace
      if (requester?.role === "ADMIN") {
        // wsUserIds already contains all users of the workspace
      } else if (effectiveRequesterId) {
        // Rank-based access for GESTIONNAIRE / USER
        const assignments = await prisma.userRoleAssignment.findMany({
          where: { role: { workspaceId } },
          select: { userId: true, role: { select: { rank: true } } },
        });

        const rankByUser = {};
        for (const { userId, role } of assignments) {
          rankByUser[userId] = Math.max(rankByUser[userId] ?? 0, role.rank ?? 0);
        }
        const requesterRank = rankByUser[effectiveRequesterId] ?? 0;

        if (requesterRank > 0) {
          // Include documents of users with strictly lower rank
          wsUserIds = wsUsers
            .map(u => u.id)
            .filter(uid => (rankByUser[uid] ?? 0) < requesterRank || uid === effectiveRequesterId);
        } else {
          // No rank elevation — only own docs + global
          wsUserIds = [effectiveRequesterId];
        }
      }
    } catch (err) {
      console.warn("[loadKnowledgeContext] Access check error:", err.message);
    }
  }

  // Vector search: try semantic similarity first (requires pgvector + OpenAI-compatible provider)
  if (workspaceId && effectiveRequesterId) {
    try {
      const provider = await getProviderForUser(effectiveRequesterId);
      const embedding = await generateEmbedding(query, provider);
      if (embedding) {
        const vectorDocs = await searchSimilarDocs(workspaceId, embedding, limit, wsUserIds);
        if (vectorDocs.length > 0) {
          return vectorDocs
            .map((d) => d.summary ? `### Summary\n${d.summary}\n\n${d.content}` : d.content)
            .join("\n\n---\n\n");
        }
      }
    } catch {
      // Fall through to SQL LIKE
    }
  }

  // SQL LIKE fallback
  const docs = await prisma.knowledgeDocument.findMany({
    where: {
      isActive: true,
      OR: [
        // Global platform docs (no owner, no agent = truly global)
        { clientId: null, agentId: null },
        // Agent-specific docs (if agent is accessible from this workspace)
        { agentId },
        // Docs from workspace users
        ...(wsUserIds.length > 0 ? [{ clientId: { in: wsUserIds } }] : []),
      ],
      AND: [
        {
          OR: [
            { title: { contains: normalizedQuery, mode: "insensitive" } },
            { content: { contains: normalizedQuery, mode: "insensitive" } }
          ]
        }
      ]
    },
    select: { title: true, content: true, agentId: true, clientId: true },
    orderBy: { updatedAt: "desc" },
    take: limit
  });

  if (docs.length === 0) return null;

  return docs
    .map((d) => `### ${d.title}\n${d.content}`)
    .join("\n\n---\n\n");
}
