/**
 * AdminPlatformSubAgent — Tools for platform-wide analytics and insights
 *
 * Features:
 * - getOverviewStats() — aggregate platform metrics
 * - getWorkspaceDetails(workspaceId) — detail on specific workspace
 * - getUsersList(filters) — list users with filtering
 * - getTokenUsageByPeriod(startDate, endDate) — usage timeline
 * - getActiveAgents() — agent inventory by workspace
 */

import { BaseSubAgent } from "./base-sub-agent.js";
import { prisma } from "../../prisma.js";

export class AdminPlatformSubAgent extends BaseSubAgent {
  constructor({ provider }) {
    const systemPrompt = `Tu es l'assistant administrateur de la plateforme Boatswain.

Tu as accès aux données agrégées de la plateforme et tu peux répondre à des questions sur :
- Les statistiques globales : workspaces, utilisateurs, agents, conversations, tokens
- Les détails d'un workspace spécifique : plan, users, usage tokens
- La liste des utilisateurs (avec filtres par rôle, workspace)
- La consommation de tokens sur une période donnée
- L'inventaire des agents actifs par workspace

Réponds toujours en français, de façon concise et avec des données précises.
Formate les données tabulaires en markdown (tableaux ou listes à puces).`;

    const tools = [
      {
        name: "getOverviewStats",
        description: "Statistiques globales de la plateforme : workspaces, utilisateurs, agents, conversations, tokens consommés (30 derniers jours)",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "getWorkspaceDetails",
        description: "Détails d'un workspace spécifique : propriétaire, plan, utilisateurs, agents, consommation tokens",
        parameters: {
          type: "object",
          properties: {
            workspaceId: { type: "string", description: "ID du workspace" },
          },
          required: ["workspaceId"],
        },
      },
      {
        name: "getUsersList",
        description: "Liste des utilisateurs de la plateforme avec filtres optionnels",
        parameters: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["admin", "client", "sub_client"], description: "Filtrer par rôle" },
            workspaceId: { type: "string", description: "Filtrer par workspace" },
            limit: { type: "number", description: "Nombre max de résultats (défaut 50)" },
          },
        },
      },
      {
        name: "getTokenUsageByPeriod",
        description: "Consommation de tokens sur une période : total, par provider, par jour",
        parameters: {
          type: "object",
          properties: {
            startDate: { type: "string", description: "Date de début ISO (YYYY-MM-DD)" },
            endDate: { type: "string", description: "Date de fin ISO (YYYY-MM-DD)" },
          },
          required: ["startDate", "endDate"],
        },
      },
      {
        name: "getActiveAgents",
        description: "Inventaire des agents actifs par workspace et par type",
        parameters: {
          type: "object",
          properties: {
            workspaceId: { type: "string", description: "Filtrer par workspace (optionnel)" },
            agentType: { type: "string", description: "Filtrer par type (local, mistral-remote, openai-remote)" },
          },
        },
      },
    ];

    super({ type: "admin-platform", provider, tools, systemPrompt });
  }

  /**
   * Override execute to use custom _doWork pattern (no LLM tool-calling loop needed —
   * keyword-based routing is sufficient for admin stats queries).
   */
  async execute({ demande, contexte = "", toolContext = {}, thinkingMode = "low", onEvent = null }) {
    try {
      const toolCalls = this._parseToolsNeeded(demande);
      const results = {};

      for (const toolCall of toolCalls) {
        if (onEvent) {
          onEvent({ type: "tool_call", subAgentType: this.type, toolName: toolCall.name, toolArgs: toolCall.args, operation: "read", iteration: 0 });
        }
        try {
          results[toolCall.name] = await this._executeTool(toolCall.name, toolCall.args);
          if (onEvent) {
            onEvent({ type: "tool_result", subAgentType: this.type, toolName: toolCall.name, success: true, resultPreview: null, iteration: 0 });
          }
        } catch (err) {
          console.error(`[AdminPlatformSubAgent] Tool error ${toolCall.name}:`, err);
          results[toolCall.name] = { error: err.message };
        }
      }

      const output = this._synthesizeResults(demande, results);
      return {
        demande,
        contexte,
        think: `${Object.keys(results).length} source(s) de données interrogée(s)`,
        output,
        sources: ["admin_platform"],
        tokensInput: 0,
        tokensOutput: 0,
      };
    } catch (err) {
      console.error("[AdminPlatformSubAgent] Error:", err);
      return { demande, contexte, think: "", output: `Erreur: ${err.message}`, sources: [], tokensInput: 0, tokensOutput: 0 };
    }
  }

  _parseToolsNeeded(demande) {
    const lower = demande.toLowerCase();
    const tools = [];

    if (
      lower.includes("overview") || lower.includes("résumé") || lower.includes("résume") ||
      lower.includes("total") || lower.includes("statistiques") || lower.includes("stats") ||
      lower.includes("combien") || lower.includes("nombre") || lower.includes("métriques")
    ) {
      tools.push({ name: "getOverviewStats", args: {} });
    }

    if (lower.includes("workspace") && !lower.includes("tous les workspaces") && !tools.find(t => t.name === "getWorkspaceDetails")) {
      const wsIdMatch = demande.match(/workspace[:\s]+([a-z0-9_-]+)/i);
      if (wsIdMatch) {
        tools.push({ name: "getWorkspaceDetails", args: { workspaceId: wsIdMatch[1] } });
      }
    }

    if (lower.includes("utilisateur") || lower.includes("user") || lower.includes("équipe") || lower.includes("membre")) {
      const roleMatch = demande.match(/\b(admin|client|sub_client)\b/i);
      const wsIdMatch = demande.match(/workspace[:\s]+([a-z0-9_-]+)/i);
      tools.push({
        name: "getUsersList",
        args: {
          ...(roleMatch && { role: roleMatch[1].toLowerCase() }),
          ...(wsIdMatch && { workspaceId: wsIdMatch[1] }),
          limit: 50,
        },
      });
    }

    if (lower.includes("token") || lower.includes("consommation") || lower.includes("usage")) {
      const dateMatch = demande.match(/(\d{4}-\d{2}-\d{2})/g);
      const today = new Date();
      const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      tools.push({
        name: "getTokenUsageByPeriod",
        args: {
          startDate: dateMatch?.[0] || weekAgo.toISOString().split("T")[0],
          endDate: dateMatch?.[1] || today.toISOString().split("T")[0],
        },
      });
    }

    if (lower.includes("agent") || lower.includes("bot") || lower.includes("inventaire")) {
      const wsIdMatch = demande.match(/workspace[:\s]+([a-z0-9_-]+)/i);
      const typeMatch = demande.match(/\b(local|cloud|mistral|openai)\b/i);
      tools.push({
        name: "getActiveAgents",
        args: {
          ...(wsIdMatch && { workspaceId: wsIdMatch[1] }),
          ...(typeMatch && { agentType: typeMatch[1].toLowerCase() }),
        },
      });
    }

    if (tools.length === 0) {
      tools.push({ name: "getOverviewStats", args: {} });
    }

    return tools;
  }

  async _executeTool(name, args) {
    switch (name) {
      case "getOverviewStats":       return this._getOverviewStats();
      case "getWorkspaceDetails":    return this._getWorkspaceDetails(args.workspaceId);
      case "getUsersList":           return this._getUsersList(args);
      case "getTokenUsageByPeriod":  return this._getTokenUsageByPeriod(args);
      case "getActiveAgents":        return this._getActiveAgents(args);
      default: throw new Error(`Outil inconnu: ${name}`);
    }
  }

  // ── Tool implementations ──────────────────────────────────────────────────

  async _getOverviewStats() {
    const [totalWorkspaces, totalUsers, totalAgents, totalConversations, tokenStats] = await Promise.all([
      prisma.workspace.count({ where: { status: "active" } }),
      prisma.user.count(),
      prisma.agent.count({ where: { isActive: true } }),
      prisma.conversation.count(),
      prisma.message.aggregate({
        where: {
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          role: "assistant",
        },
        _sum: { tokensInput: true, tokensOutput: true },
      }),
    ]);

    const totalTokens = (tokenStats._sum.tokensInput || 0) + (tokenStats._sum.tokensOutput || 0);

    return {
      totalWorkspaces,
      totalUsers,
      totalAgents,
      totalConversations,
      totalTokens30d: totalTokens,
      averageTokensPerConversation: totalConversations > 0 ? Math.round(totalTokens / totalConversations) : 0,
    };
  }

  async _getWorkspaceDetails(workspaceId) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        workspacePlan: { select: { name: true, monthlyTokenLimit: true } },
        _count: { select: { agents: true, users: true } },
      },
    });

    if (!workspace) return { error: `Workspace ${workspaceId} introuvable` };

    // Find the workspace owner (client role)
    const owner = await prisma.user.findFirst({
      where: { workspaceId, role: "client" },
      select: { email: true, firstName: true, lastName: true },
    });

    // Token usage from messages in this workspace
    const tokenStats = await prisma.message.aggregate({
      where: { workspaceId, role: "assistant" },
      _sum: { tokensInput: true, tokensOutput: true },
    });

    return {
      id: workspace.id,
      name: workspace.name,
      status: workspace.status,
      owner: owner ? { email: owner.email, name: `${owner.firstName || ""} ${owner.lastName || ""}`.trim() || owner.email } : null,
      plan: workspace.workspacePlan,
      usersCount: workspace._count.users,
      agentsCount: workspace._count.agents,
      tokenUsedTotal: (tokenStats._sum.tokensInput || 0) + (tokenStats._sum.tokensOutput || 0),
      tokenLimit: workspace.workspacePlan?.monthlyTokenLimit || 0,
      createdAt: workspace.createdAt,
    };
  }

  async _getUsersList({ role, workspaceId, limit = 50 }) {
    const where = {};
    if (role) where.role = role;
    if (workspaceId) where.workspaceId = workspaceId;

    const users = await prisma.user.findMany({
      where,
      select: { id: true, email: true, firstName: true, lastName: true, role: true, workspaceId: true, createdAt: true },
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    return {
      count: users.length,
      users: users.map((u) => ({
        ...u,
        name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email,
      })),
    };
  }

  async _getTokenUsageByPeriod({ startDate, endDate }) {
    const start = new Date(startDate);
    const end = new Date(endDate + "T23:59:59Z");

    // By provider
    const byProvider = await prisma.message.groupBy({
      by: ["provider"],
      where: { createdAt: { gte: start, lte: end }, role: "assistant" },
      _sum: { tokensInput: true, tokensOutput: true },
      _count: { id: true },
    });

    // Total
    const total = await prisma.message.aggregate({
      where: { createdAt: { gte: start, lte: end }, role: "assistant" },
      _sum: { tokensInput: true, tokensOutput: true },
    });

    return {
      startDate,
      endDate,
      totalTokens: (total._sum.tokensInput || 0) + (total._sum.tokensOutput || 0),
      byProvider: byProvider.map((p) => ({
        provider: p.provider || "inconnu",
        tokensInput: p._sum.tokensInput || 0,
        tokensOutput: p._sum.tokensOutput || 0,
        total: (p._sum.tokensInput || 0) + (p._sum.tokensOutput || 0),
        messages: p._count.id,
      })),
    };
  }

  async _getActiveAgents({ workspaceId, agentType } = {}) {
    const where = { isActive: true };
    if (agentType) where.agentType = agentType;
    if (workspaceId) where.workspaceId = workspaceId;

    const agents = await prisma.agent.findMany({
      where,
      select: { id: true, name: true, agentType: true, workspaceId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    const byType = {};
    for (const a of agents) {
      const t = a.agentType || "unknown";
      byType[t] = (byType[t] || 0) + 1;
    }

    return {
      total: agents.length,
      byType: Object.entries(byType).map(([type, count]) => ({ type, count })),
      agents: agents.map((a) => ({ id: a.id, name: a.name, type: a.agentType, workspaceId: a.workspaceId })),
    };
  }

  _synthesizeResults(demande, results) {
    const parts = [];

    for (const [toolName, result] of Object.entries(results)) {
      if (result.error) {
        parts.push(`⚠️ ${toolName} : ${result.error}`);
        continue;
      }

      if (toolName === "getOverviewStats") {
        parts.push(`**Vue d'ensemble de la plateforme**
- Workspaces actifs : ${result.totalWorkspaces}
- Utilisateurs : ${result.totalUsers}
- Agents actifs : ${result.totalAgents}
- Conversations (total) : ${result.totalConversations}
- Tokens consommés (30 jours) : ${result.totalTokens30d.toLocaleString()}
- Moy. tokens/conversation : ${result.averageTokensPerConversation}`);
      }

      if (toolName === "getWorkspaceDetails") {
        parts.push(`**Workspace : ${result.name}**
- Propriétaire : ${result.owner?.email || "N/A"}
- Plan : ${result.plan?.name || "Aucun"}
- Utilisateurs : ${result.usersCount}
- Agents : ${result.agentsCount}
- Tokens consommés : ${result.tokenUsedTotal.toLocaleString()} / ${result.tokenLimit.toLocaleString()}`);
      }

      if (toolName === "getUsersList") {
        const list = result.users.slice(0, 10).map(u => `  • ${u.name} (${u.email}) — ${u.role}`).join("\n");
        parts.push(`**Utilisateurs** (${result.count} au total)\n${list}`);
      }

      if (toolName === "getTokenUsageByPeriod") {
        const provSummary = result.byProvider.map(p => `  • ${p.provider} : ${p.total.toLocaleString()} tokens (${p.messages} messages)`).join("\n");
        parts.push(`**Tokens — ${result.startDate} → ${result.endDate}**
Total : ${result.totalTokens.toLocaleString()} tokens

Par provider :
${provSummary || "  Aucune donnée"}`);
      }

      if (toolName === "getActiveAgents") {
        const typeSummary = result.byType.map(t => `  • ${t.type} : ${t.count}`).join("\n");
        parts.push(`**Agents actifs** (${result.total} total)\n${typeSummary}`);
      }
    }

    return parts.join("\n\n") || "Aucune donnée disponible.";
  }
}
