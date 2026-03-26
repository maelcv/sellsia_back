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
import { prisma } from "../../src/prisma.js";

export class AdminPlatformSubAgent extends BaseSubAgent {
  constructor(provider) {
    const systemPrompt = `You are an admin platform agent with access to aggregate analytics and statistics.

You can query:
- Overview stats: total workspaces, users, agents, token consumption
- Workspace details: owner, users, agents, subscription plan
- User list with filters by role, workspace, or date
- Token usage trends over time
- Active agents inventory by workspace

Always respond with actionable insights. Format data as JSON tables when appropriate.`;

    const tools = [
      {
        name: "getOverviewStats",
        description: "Get aggregate platform metrics: total workspaces, users, agents, conversations, token consumption",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "getWorkspaceDetails",
        description: "Get detailed information about a specific workspace: owner, plan, users, agents, token usage",
        parameters: {
          type: "object",
          properties: {
            workspaceId: { type: "string", description: "Workspace ID" },
          },
          required: ["workspaceId"],
        },
      },
      {
        name: "getUsersList",
        description: "Get list of platform users with optional filters",
        parameters: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["admin", "client", "sub_client"], description: "Filter by role" },
            workspaceId: { type: "string", description: "Filter by workspace" },
            limit: { type: "number", description: "Max results (default 50)" },
          },
        },
      },
      {
        name: "getTokenUsageByPeriod",
        description: "Get token consumption timeline over a date range",
        parameters: {
          type: "object",
          properties: {
            startDate: { type: "string", description: "ISO date (YYYY-MM-DD)" },
            endDate: { type: "string", description: "ISO date (YYYY-MM-DD)" },
            groupBy: { type: "string", enum: ["day", "week", "month"], description: "Aggregation period" },
          },
          required: ["startDate", "endDate"],
        },
      },
      {
        name: "getActiveAgents",
        description: "Get inventory of active agents by workspace, type, and provider",
        parameters: {
          type: "object",
          properties: {
            workspaceId: { type: "string", description: "Optional: filter by workspace" },
            agentType: { type: "string", enum: ["local", "mistral-remote"], description: "Filter by type" },
          },
        },
      },
    ];

    super({ type: "admin_platform", provider, tools, systemPrompt });
  }

  /**
   * Override execute to use custom _doWork pattern
   */
  async execute({ demande, contexte = "", toolContext = {}, thinkingMode = "low", onEvent = null }) {
    try {
      const result = await this._doWork({ demande, toolContext }, { contexte, onEvent });
      return {
        demande,
        contexte: result.contexte || contexte,
        think: result.reasoning || "",
        output: result.output || "",
        sources: result.sources || [],
        tokensInput: result.tokens || 0,
        tokensOutput: 0,
      };
    } catch (err) {
      console.error("[AdminPlatformSubAgent] Error:", err);
      return {
        demande,
        contexte,
        think: "",
        output: `Error: ${err.message}`,
        sources: [],
        tokensInput: 0,
        tokensOutput: 0,
      };
    }
  }

  /**
   * Parse user demande and call appropriate tools
   */
  async _doWork(instruction, context = {}) {
    const { demande } = instruction;

    // Parse what tools are needed based on the query
    const toolCalls = this._parseToolsNeeded(demande);

    const results = {};
    for (const toolCall of toolCalls) {
      try {
        const output = await this._executeTool(toolCall.name, toolCall.args);
        results[toolCall.name] = output;
      } catch (err) {
        console.error(`[AdminPlatformSubAgent] Tool error ${toolCall.name}:`, err);
        results[toolCall.name] = { error: err.message };
      }
    }

    // Synthesize results into human-readable output
    const output = this._synthesizeResults(demande, results);

    return {
      output,
      contexte: context.contexte,
      reasoning: `Analyzed ${Object.keys(results).length} data source(s) to answer the query`,
      sources: ["admin_platform"],
      tokens: 0,
    };
  }

  /**
   * Detect which tools are needed based on the user's demande
   */
  _parseToolsNeeded(demande) {
    const lower = demande.toLowerCase();
    const tools = [];

    // Overview: total stats, summary, metrics
    if (lower.includes("overview") || lower.includes("summary") || lower.includes("total") || lower.includes("metrics") || lower.includes("statistics")) {
      tools.push({ name: "getOverviewStats", args: {} });
    }

    // Workspace details: specific workspace, workspace info
    if (lower.includes("workspace") && !lower.includes("all workspaces")) {
      const wsIdMatch = demande.match(/workspace[:\s]+([a-z0-9-]+)/i);
      if (wsIdMatch) {
        tools.push({ name: "getWorkspaceDetails", args: { workspaceId: wsIdMatch[1] } });
      }
    }

    // Users: list users, users by role, team
    if (lower.includes("user") || lower.includes("team") || lower.includes("admin") || lower.includes("collaborator")) {
      const roleMatch = demande.match(/(admin|client|sub_client|collaborator)/i);
      const wsIdMatch = demande.match(/workspace[:\s]+([a-z0-9-]+)/i);
      tools.push({
        name: "getUsersList",
        args: {
          ...(roleMatch && { role: roleMatch[1].toLowerCase() }),
          ...(wsIdMatch && { workspaceId: wsIdMatch[1] }),
          limit: 50,
        },
      });
    }

    // Token usage: consumption, usage over time, trend
    if (lower.includes("token") || lower.includes("consumption") || lower.includes("usage")) {
      const dateMatch = demande.match(/(\d{4}-\d{2}-\d{2})/g);
      if (dateMatch && dateMatch.length >= 2) {
        tools.push({
          name: "getTokenUsageByPeriod",
          args: {
            startDate: dateMatch[0],
            endDate: dateMatch[1],
            groupBy: "day",
          },
        });
      } else {
        // Default: last 7 days
        const today = new Date();
        const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        tools.push({
          name: "getTokenUsageByPeriod",
          args: {
            startDate: weekAgo.toISOString().split("T")[0],
            endDate: today.toISOString().split("T")[0],
            groupBy: "day",
          },
        });
      }
    }

    // Agents: agent list, inventory, active agents
    if (lower.includes("agent") || lower.includes("bot") || lower.includes("inventory")) {
      const wsIdMatch = demande.match(/workspace[:\s]+([a-z0-9-]+)/i);
      const typeMatch = demande.match(/(local|cloud|mistral)/i);
      tools.push({
        name: "getActiveAgents",
        args: {
          ...(wsIdMatch && { workspaceId: wsIdMatch[1] }),
          ...(typeMatch && { agentType: typeMatch[1].toLowerCase() }),
        },
      });
    }

    // If no tools detected, get overview
    if (tools.length === 0) {
      tools.push({ name: "getOverviewStats", args: {} });
    }

    return tools;
  }

  /**
   * Execute tool and return results
   */
  async _executeTool(name, args) {
    switch (name) {
      case "getOverviewStats":
        return this._getOverviewStats();
      case "getWorkspaceDetails":
        return this._getWorkspaceDetails(args.workspaceId);
      case "getUsersList":
        return this._getUsersList(args);
      case "getTokenUsageByPeriod":
        return this._getTokenUsageByPeriod(args);
      case "getActiveAgents":
        return this._getActiveAgents(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Get platform overview statistics
   */
  async _getOverviewStats() {
    const [
      totalWorkspaces,
      totalUsers,
      totalAgents,
      totalConversations,
      tokenStats,
    ] = await Promise.all([
      prisma.workspace.count(),
      prisma.user.count(),
      prisma.agent.count({ where: { is_active: 1 } }),
      prisma.conversation.count(),
      prisma.tokenUsage.groupBy({
        by: ["provider"],
        _sum: { tokensUsed: true },
        where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      }),
    ]);

    const totalTokens = tokenStats.reduce((sum, s) => sum + (s._sum.tokensUsed || 0), 0);

    return {
      totalWorkspaces,
      totalUsers,
      totalAgents,
      totalConversations,
      totalTokens30d: totalTokens,
      averageTokensPerConversation: totalConversations > 0 ? Math.round(totalTokens / totalConversations) : 0,
    };
  }

  /**
   * Get details for a specific workspace
   */
  async _getWorkspaceDetails(workspaceId) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        owner: { select: { email: true, firstName: true, lastName: true } },
        plan: { select: { name: true, monthlyTokenLimit: true } },
        _count: {
          select: { agents: true, users: true },
        },
      },
    });

    if (!workspace) {
      return { error: `Workspace ${workspaceId} not found` };
    }

    const tokenUsage = await prisma.tokenUsage.aggregate({
      where: { conversation: { workspaceId } },
      _sum: { tokensUsed: true },
    });

    return {
      id: workspace.id,
      name: workspace.name,
      owner: workspace.owner,
      plan: workspace.plan,
      usersCount: workspace._count.users,
      agentsCount: workspace._count.agents,
      tokenUsedThisMonth: tokenUsage._sum.tokensUsed || 0,
      tokenLimit: workspace.plan?.monthlyTokenLimit || 0,
      createdAt: workspace.createdAt,
    };
  }

  /**
   * Get list of users with filters
   */
  async _getUsersList(args) {
    const { role, workspaceId, limit = 50 } = args;

    const where = {};
    if (role) where.role = role;
    if (workspaceId) where.workspaceId = workspaceId;

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        workspaceId: true,
        createdAt: true,
      },
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

  /**
   * Get token usage over a date range
   */
  async _getTokenUsageByPeriod(args) {
    const { startDate, endDate, groupBy = "day" } = args;

    const start = new Date(startDate);
    const end = new Date(endDate);

    const usage = await prisma.tokenUsage.groupBy({
      by: ["provider"],
      where: {
        createdAt: { gte: start, lte: end },
      },
      _sum: { tokensUsed: true },
      _count: { id: true },
    });

    const dailyUsage = await prisma.tokenUsage.findMany({
      where: {
        createdAt: { gte: start, lte: end },
      },
      select: { createdAt: true, tokensUsed: true },
      orderBy: { createdAt: "asc" },
    });

    // Aggregate by day
    const byDay = {};
    for (const item of dailyUsage) {
      const day = item.createdAt.toISOString().split("T")[0];
      if (!byDay[day]) byDay[day] = 0;
      byDay[day] += item.tokensUsed || 0;
    }

    return {
      startDate,
      endDate,
      byProvider: usage.map((u) => ({
        provider: u.provider || "unknown",
        tokens: u._sum.tokensUsed || 0,
        count: u._count.id,
      })),
      byDay: Object.entries(byDay).map(([day, tokens]) => ({ day, tokens })),
      totalTokens: Object.values(byDay).reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Get active agents inventory
   */
  async _getActiveAgents(args) {
    const { workspaceId, agentType } = args;

    const where = { is_active: 1 };
    if (agentType) where.agent_type = agentType;
    if (workspaceId) where.workspace_id = workspaceId;

    const agents = await prisma.agent.findMany({
      where,
      select: {
        id: true,
        name: true,
        agent_type: true,
        workspace_id: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Group by type and workspace
    const byType = {};
    const byWorkspace = {};

    for (const agent of agents) {
      const type = agent.agent_type || "unknown";
      const wsId = agent.workspace_id || "global";

      if (!byType[type]) byType[type] = [];
      byType[type].push(agent);

      if (!byWorkspace[wsId]) byWorkspace[wsId] = [];
      byWorkspace[wsId].push(agent);
    }

    return {
      total: agents.length,
      byType: Object.entries(byType).map(([type, items]) => ({ type, count: items.length })),
      byWorkspace: Object.entries(byWorkspace).map(([wsId, items]) => ({
        workspaceId: wsId === "global" ? null : wsId,
        count: items.length,
      })),
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.agent_type,
        workspaceId: a.workspace_id,
      })),
    };
  }

  /**
   * Synthesize results into readable output
   */
  _synthesizeResults(demande, results) {
    const parts = [];

    for (const [toolName, result] of Object.entries(results)) {
      if (result.error) {
        parts.push(`⚠️ ${toolName}: ${result.error}`);
        continue;
      }

      if (toolName === "getOverviewStats") {
        parts.push(`
**Platform Overview**
- Workspaces: ${result.totalWorkspaces}
- Total Users: ${result.totalUsers}
- Active Agents: ${result.totalAgents}
- Conversations (all time): ${result.totalConversations}
- Token Usage (last 30 days): ${result.totalTokens30d}
- Avg tokens/conversation: ${result.averageTokensPerConversation}`);
      }

      if (toolName === "getWorkspaceDetails") {
        parts.push(`
**Workspace: ${result.name}**
- Owner: ${result.owner.email}
- Plan: ${result.plan?.name || "None"}
- Users: ${result.usersCount}
- Agents: ${result.agentsCount}
- Token Usage: ${result.tokenUsedThisMonth} / ${result.tokenLimit} this month`);
      }

      if (toolName === "getUsersList") {
        const userList = result.users
          .slice(0, 10)
          .map((u) => `  • ${u.name} (${u.email}) - ${u.role}`)
          .join("\n");
        parts.push(`
**Users** (${result.count} total)
${userList}`);
      }

      if (toolName === "getTokenUsageByPeriod") {
        const providerSummary = result.byProvider
          .map((p) => `  • ${p.provider}: ${p.tokens} tokens (${p.count} uses)`)
          .join("\n");
        parts.push(`
**Token Usage: ${result.startDate} to ${result.endDate}**
Total: ${result.totalTokens} tokens

By Provider:
${providerSummary}`);
      }

      if (toolName === "getActiveAgents") {
        const typeSummary = result.byType.map((t) => `  • ${t.type}: ${t.count}`).join("\n");
        parts.push(`
**Active Agents** (${result.total} total)

By Type:
${typeSummary}`);
      }
    }

    return parts.join("\n\n");
  }
}
