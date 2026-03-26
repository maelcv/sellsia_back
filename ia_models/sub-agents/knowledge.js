/**
 * KnowledgeSubAgent — Intelligent knowledge base search
 *
 * Features:
 * - Fuzzy text matching on knowledge documents
 * - Smart caching of recent conversation results
 * - Workspace-scoped + user-scoped documents
 * - Returns structured report with sources
 */

import { BaseSubAgent } from "./base-sub-agent.js";
import { prisma } from "../../src/prisma.js";

export class KnowledgeSubAgent extends BaseSubAgent {
  constructor(provider) {
    super("knowledge", provider);
    this.searchLimit = 5; // Max documents to return
  }

  /**
   * Search knowledge base and conversation cache
   * @param {Object} instruction
   * @param {string} instruction.query - What to search for
   * @param {number} instruction.userId - Scope search to this user
   * @param {string} [instruction.workspaceId] - Scope search to this workspace
   * @param {string} [instruction.agentId] - Filter to specific agent's knowledge
   * @param {Object} context - { conversationHistory, ... }
   */
  async _doWork(instruction, context = {}) {
    const startTime = Date.now();
    let tokensUsed = 0;

    try {
      const { query, userId, workspaceId, agentId } = instruction;

      if (!query || query.length < 2) {
        return {
          success: false,
          data: { documents: [], cacheHits: [], message: "Query too short" },
          tokens: 0,
          reasoning: "Query must be at least 2 characters",
        };
      }

      // Step 1: Search knowledge base
      const documents = await this._searchDocuments({
        query,
        userId,
        workspaceId,
        agentId,
      });

      // Step 2: Search conversation cache (recent conversation results)
      const cacheHits = await this._searchConversationCache({
        query,
        userId,
        workspaceId,
      });

      // Step 3: Rank and deduplicate results
      const results = this._deduplicateAndRank([...documents, ...cacheHits]);

      // Step 4: Format report
      const report = {
        documents: results.slice(0, this.searchLimit),
        totalFound: results.length,
        searchQuery: query,
        scopes: {
          userId: userId || "global",
          workspaceId: workspaceId || "global",
          agentId: agentId || "any",
        },
        timestamp: new Date().toISOString(),
      };

      return {
        success: true,
        data: report,
        tokens: tokensUsed,
        reasoning: `Found ${report.documents.length} relevant documents in knowledge base and ${cacheHits.length} recent conversation results`,
        confidence: Math.min(1.0, results.length / 10), // Higher confidence with more results
      };
    } catch (err) {
      console.error("[KnowledgeSubAgent] Error:", err);
      return {
        success: false,
        data: { error: err.message },
        tokens: 0,
        reasoning: `Search failed: ${err.message}`,
        confidence: 0,
      };
    }
  }

  /**
   * Search knowledge documents with fuzzy matching
   */
  async _searchDocuments({ query, userId, workspaceId, agentId }) {
    const normalizedQuery = query.toLowerCase();

    const documents = await prisma.knowledgeDocument.findMany({
      where: {
        isActive: true,
        // Scope to user or workspace
        OR: [
          { clientId: userId || undefined },
          { clientId: null }, // Global docs
        ],
        // Optionally filter by agent
        ...(agentId ? { OR: [{ agentId }, { agentId: null }] } : {}),
        // Text search (case-insensitive contains)
        OR: [
          { title: { contains: normalizedQuery, mode: "insensitive" } },
          { content: { contains: normalizedQuery, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        title: true,
        content: true,
        type: true,
        updatedAt: true,
      },
      take: 20, // Get more, then filter
    });

    // Score and filter by relevance
    return documents
      .map((doc) => ({
        ...doc,
        source: "knowledge_base",
        relevanceScore: this._scoreRelevance(doc, query),
      }))
      .filter((doc) => doc.relevanceScore > 0.3) // Minimum relevance
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, this.searchLimit);
  }

  /**
   * Search recent conversation cache (avoid duplicate queries)
   * Returns insights from similar past questions
   */
  async _searchConversationCache({ query, userId, workspaceId }) {
    // Get recent messages to check for similar questions
    const recentMessages = await prisma.message.findMany({
      where: {
        role: "assistant",
        conversation: {
          userId,
          ...(workspaceId ? { user: { workspaceId } } : {}),
        },
        createdAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
        },
      },
      select: {
        id: true,
        content: true,
        createdAt: true,
        conversation: { select: { topic: true } },
      },
      take: 50,
      orderBy: { createdAt: "desc" },
    });

    // Score for similarity to current query
    return recentMessages
      .map((msg) => ({
        id: msg.id,
        title: msg.conversation?.topic || "Recent answer",
        content: msg.content.substring(0, 500), // Truncate
        source: "conversation_cache",
        relevanceScore: this._scoreSimilarity(msg.content, query),
        createdAt: msg.createdAt,
      }))
      .filter((msg) => msg.relevanceScore > 0.4)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 3); // Limit cache hits
  }

  /**
   * Score document relevance based on:
   * - Keyword matches in title (weighted higher)
   * - Keyword matches in content
   * - Document freshness (recent docs slightly boosted)
   */
  _scoreRelevance(doc, query) {
    const queryTerms = query.toLowerCase().split(/\s+/);
    const titleLower = doc.title.toLowerCase();
    const contentLower = doc.content.toLowerCase();

    let score = 0;

    // Title matches (weight = 0.7)
    for (const term of queryTerms) {
      if (titleLower.includes(term)) score += 0.7;
    }

    // Content matches (weight = 0.3)
    for (const term of queryTerms) {
      if (contentLower.includes(term)) score += 0.3;
    }

    // Freshness bonus (documents updated in last week)
    const daysSinceUpdate = (Date.now() - new Date(doc.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate < 7) score += 0.1;

    // Normalize to 0-1
    return Math.min(1, score / (queryTerms.length * 0.7));
  }

  /**
   * Score similarity between two texts (simple cosine-like)
   */
  _scoreSimilarity(text1, text2) {
    const terms2 = text2.toLowerCase().split(/\s+/);
    const text1Lower = text1.toLowerCase();

    let matches = 0;
    for (const term of terms2) {
      if (term.length > 2 && text1Lower.includes(term)) matches++;
    }

    return matches / Math.max(1, terms2.length);
  }

  /**
   * Deduplicate and rank combined results
   */
  _deduplicateAndRank(results) {
    const seen = new Set();
    const unique = [];

    for (const result of results) {
      // Use title + source as dedup key
      const key = `${result.title}:${result.source}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(result);
      }
    }

    // Sort by relevance score
    return unique.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  }
}
