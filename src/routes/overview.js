import express from "express";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

/**
 * Builds real per-day token series from the messages table for the last 7 days.
 * Returns { labels, seriesA (received/sent), seriesB (processed/returned) }.
 *
 * @param {number|null} userId - null = all users (admin view)
 * @param {"input"|"output"|"both_in"|"both_out"} mode
 *   - "both_in"  → seriesA = tokens_input,  seriesB = tokens_input + tokens_output
 *   - "both_out" → seriesA = tokens_input,   seriesB = tokens_output
 */
async function buildRealSeries(userId, mode) {
  const dayLabels = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

  // Build last 7 calendar days (today = index 6)
  const days = [];
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10)); // "YYYY-MM-DD"
    labels.push(dayLabels[d.getDay()]);
  }

  const startDate = days[0];

  let rows;
  if (userId) {
    rows = await prisma.$queryRaw`
      SELECT m.created_at::date as day,
             COALESCE(SUM(m.tokens_input), 0)::int  as ti,
             COALESCE(SUM(m.tokens_output), 0)::int as to_
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = ${userId} AND m.role = 'assistant' AND m.created_at::date >= ${startDate}::date
      GROUP BY m.created_at::date`;
  } else {
    rows = await prisma.$queryRaw`
      SELECT m.created_at::date as day,
             COALESCE(SUM(m.tokens_input), 0)::int  as ti,
             COALESCE(SUM(m.tokens_output), 0)::int as to_
      FROM messages m
      WHERE m.role = 'assistant' AND m.created_at::date >= ${startDate}::date
      GROUP BY m.created_at::date`;
  }

  // Index by day string
  const byDay = {};
  for (const r of rows) {
    // PostgreSQL returns date as a Date object, convert to YYYY-MM-DD string
    const dayStr = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day);
    byDay[dayStr] = { ti: Number(r.ti), to_: Number(r.to_) };
  }

  const seriesA = [];
  const seriesB = [];
  for (const day of days) {
    const d = byDay[day] || { ti: 0, to_: 0 };
    if (mode === "both_in") {
      // Received = tokens_input, Processed = tokens_input + tokens_output
      seriesA.push(d.ti);
      seriesB.push(d.ti + d.to_);
    } else {
      // Sent = tokens_input, Returned = tokens_output
      seriesA.push(d.ti);
      seriesB.push(d.to_);
    }
  }

  return { labels, seriesA, seriesB };
}

router.get("/client", requireAuth, requireRole("client", "sub_client", "collaborator"), async (req, res) => {
  const userId = req.user.sub;

  const grantedAgents = await prisma.userAgentAccess.count({
    where: { userId, status: "granted" }
  });

  const planInfo = await prisma.$queryRaw`
    SELECT cp.token_used as "tokenUsed", cp.token_received as "tokenReceived",
           cp.token_processed as "tokenProcessed", cp.token_sent as "tokenSent",
           cp.token_returned as "tokenReturned", cp.sellsy_connection_status as "sellsyConnectionStatus",
           p.monthly_token_limit as "tokenLimit"
    FROM client_plans cp
    JOIN plans p ON p.id = cp.plan_id
    WHERE cp.user_id = ${userId}
    LIMIT 1`;

  const plan = planInfo[0] || null;

  const serviceCount = await prisma.clientServiceLink.count({
    where: { ownerUserId: userId }
  });

  const messageTokenRow = await prisma.$queryRaw`
    SELECT COALESCE(SUM(m.tokens_input), 0)::int as "tokensInput",
           COALESCE(SUM(m.tokens_output), 0)::int as "tokensOutput"
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ${userId} AND m.role = 'assistant'`;

  const messageTokens = messageTokenRow[0] || { tokensInput: 0, tokensOutput: 0 };

  const tokenLimit = plan?.tokenLimit || 0;
  const tokenUsed = plan?.tokenUsed || (Number(messageTokens.tokensInput) + Number(messageTokens.tokensOutput));
  const tokenReceived = plan?.tokenReceived || Number(messageTokens.tokensInput);
  const tokenProcessed = plan?.tokenProcessed || (Number(messageTokens.tokensInput) + Number(messageTokens.tokensOutput));
  const tokenSent = plan?.tokenSent || Number(messageTokens.tokensInput);
  const tokenReturned = plan?.tokenReturned || Number(messageTokens.tokensOutput);
  const tokenRemaining = Math.max(0, tokenLimit - tokenUsed);
  const graphIn = await buildRealSeries(userId, "both_in");
  const graphOut = await buildRealSeries(userId, "both_out");

  return res.json({
    cards: {
      agentsOwned: grantedAgents,
      tokenUsed,
      tokenRemaining,
      tokenLimit,
      sellsyConnectionStatus: plan?.sellsyConnectionStatus || "inactive",
      externalServicesCount: serviceCount
    },
    charts: {
      tokensReceivedProcessed: {
        labels: graphIn.labels,
        received: graphIn.seriesA,
        processed: graphIn.seriesB
      },
      tokensSentReturned: {
        labels: graphOut.labels,
        sent: graphOut.seriesA,
        returned: graphOut.seriesB
      }
    }
  });
});

router.get("/admin", requireAuth, requireRole("admin"), async (_req, res) => {
  // Section 1: Token by provider IA
  const tokenByProviderRows = await prisma.$queryRaw`
    SELECT
      COALESCE(es.code, 'platform-default') as provider,
      COALESCE(SUM(m.tokens_input + m.tokens_output), 0)::int as tokens
    FROM messages m
    LEFT JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN client_service_links csl ON csl.owner_user_id = c.user_id AND csl.status = 'active'
    LEFT JOIN external_services es ON es.id = csl.service_id
    WHERE m.role = 'assistant'
    GROUP BY COALESCE(es.code, 'platform-default')
    ORDER BY tokens DESC`;
  const tokenByProvider = tokenByProviderRows.map(row => ({
    provider: row.provider,
    tokens: Number(row.tokens)
  }));

  // Section 2: Token by agent type (local vs cloud)
  const tokenByAgentTypeRows = await prisma.$queryRaw`
    SELECT
      a.agent_type as type,
      COALESCE(SUM(m.tokens_input + m.tokens_output), 0)::int as tokens
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN agents a ON a.id = c.agent_id
    WHERE m.role = 'assistant'
    GROUP BY a.agent_type`;
  const tokenByAgentType = tokenByAgentTypeRows.reduce((acc, row) => {
    acc[row.type] = Number(row.tokens);
    return acc;
  }, {});

  // Section 3: Token by workspace (top 10)
  const tokenByWorkspaceRows = await prisma.$queryRaw`
    SELECT
      w.name as workspace,
      w.id,
      COALESCE(SUM(m.tokens_input + m.tokens_output), 0)::int as tokens
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = c.user_id
    JOIN workspaces w ON w.id = u.workspace_id
    WHERE m.role = 'assistant'
    GROUP BY w.id, w.name
    ORDER BY tokens DESC
    LIMIT 10`;
  const tokenByWorkspace = tokenByWorkspaceRows.map(row => ({
    workspace: row.workspace,
    workspaceId: row.id,
    tokens: Number(row.tokens)
  }));

  // Section 4: Token by user (top 10)
  const tokenByUserRows = await prisma.$queryRaw`
    SELECT
      u.email,
      u.id,
      u.company_name as companyName,
      COALESCE(SUM(m.tokens_input + m.tokens_output), 0)::int as tokens
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = c.user_id
    WHERE m.role = 'assistant'
    GROUP BY u.id, u.email, u.company_name
    ORDER BY tokens DESC
    LIMIT 10`;
  const tokenByUser = tokenByUserRows.map(row => ({
    email: row.email,
    userId: row.id,
    companyName: row.companyName,
    tokens: Number(row.tokens)
  }));

  // Section 5: KPIs
  const activeWorkspaces = await prisma.workspace.count({
    where: { status: "active" }
  });

  const activeAgents = await prisma.agent.count({
    where: { isActive: true }
  });

  const totalConversations = await prisma.conversation.count();

  const conversationsLast7d = await prisma.conversation.count({
    where: {
      startedAt: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      }
    }
  });

  // Section 6: KPI total tokens
  const totalTokensRow = await prisma.$queryRaw`
    SELECT COALESCE(SUM(tokens_input + tokens_output), 0)::int as total
    FROM messages
    WHERE role = 'assistant'`;
  const totalTokens = Number(totalTokensRow[0]?.total || 0);

  const graphIn = await buildRealSeries(null, "both_in");

  return res.json({
    tokenByProvider,
    tokenByAgentType,
    tokenByWorkspace,
    tokenByUser,
    kpis: {
      activeWorkspaces,
      activeAgents,
      totalConversations,
      conversationsLast7d,
      totalTokens
    },
    chart: {
      labels: graphIn.labels,
      received: graphIn.seriesA,
      processed: graphIn.seriesB
    }
  });
});

// ── GET /api/overview/quotas — Per-user quota usage (admin) ──

router.get("/quotas", requireAuth, requireRole("admin"), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const total = await prisma.user.count({
    where: { role: "client" }
  });

  const rows = await prisma.$queryRaw`
    SELECT u.id as "userId", u.email, u.company_name as "companyName", u.created_at as "createdAt",
           cp.token_used as "tokenUsed", cp.token_received as "tokenReceived",
           cp.token_processed as "tokenProcessed", cp.token_sent as "tokenSent",
           cp.token_returned as "tokenReturned",
           cp.sellsy_connection_status as "sellsyStatus",
           p.name as "planName", p.monthly_token_limit as "tokenLimit",
           p.price_eur_month as "priceEur",
           (SELECT COUNT(*)::int FROM conversations c WHERE c.user_id = u.id) as "conversationCount",
           (SELECT COUNT(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = u.id) as "messageCount",
           (SELECT COUNT(*)::int FROM user_agent_access uaa WHERE uaa.user_id = u.id AND uaa.status = 'granted') as "agentsGranted"
    FROM users u
    LEFT JOIN client_plans cp ON cp.user_id = u.id
    LEFT JOIN plans p ON p.id = cp.plan_id
    WHERE u.role = 'client'
    ORDER BY cp.token_used DESC
    LIMIT ${limit} OFFSET ${offset}`;

  const quotas = rows.map((row) => ({
    ...row,
    tokenRemaining: Math.max(0, (row.tokenLimit || 0) - (row.tokenUsed || 0)),
    usagePercent: row.tokenLimit > 0
      ? Math.round(((row.tokenUsed || 0) / row.tokenLimit) * 100)
      : 0
  }));

  // Per-module (agent) usage across all users
  const byModule = await prisma.$queryRaw`
    SELECT a.id as "agentId", a.name as "agentName",
           COUNT(DISTINCT c.user_id)::int as "uniqueUsers",
           COUNT(DISTINCT c.id)::int as conversations,
           COUNT(m.id)::int as messages,
           (COALESCE(SUM(m.tokens_input), 0) + COALESCE(SUM(m.tokens_output), 0))::int as "totalTokens"
    FROM agents a
    LEFT JOIN conversations c ON c.agent_id = a.id
    LEFT JOIN messages m ON m.conversation_id = c.id AND m.role = 'assistant'
    WHERE a.is_active = true
    GROUP BY a.id
    ORDER BY "totalTokens" DESC`;

  return res.json({
    quotas,
    byModule,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

// ── GET /api/overview/subclient — Sub-client (member) dashboard ──
router.get("/subclient", requireAuth, requireRole("sub_client"), async (req, res) => {
  const userId = req.user.sub;

  // Token usage (user-specific)
  const planInfo = await prisma.$queryRaw`
    SELECT cp.token_used as "tokenUsed", cp.token_received as "tokenReceived",
           cp.token_processed as "tokenProcessed", cp.token_sent as "tokenSent",
           cp.token_returned as "tokenReturned",
           p.monthly_token_limit as "tokenLimit"
    FROM client_plans cp
    JOIN plans p ON p.id = cp.plan_id
    WHERE cp.user_id = ${userId}
    LIMIT 1`;

  const plan = planInfo[0] || { tokenUsed: 0, tokenLimit: 0, tokenReceived: 0, tokenSent: 0, tokenProcessed: 0, tokenReturned: 0 };

  // Token by agent for this user
  const tokenByAgentRows = await prisma.$queryRaw`
    SELECT
      a.id,
      a.name,
      COALESCE(SUM(m.tokens_input + m.tokens_output), 0)::int as tokens
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN agents a ON a.id = c.agent_id
    WHERE c.user_id = ${userId} AND m.role = 'assistant'
    GROUP BY a.id, a.name
    ORDER BY tokens DESC
    LIMIT 5`;
  const tokenByAgent = tokenByAgentRows.map(row => ({
    agentId: row.id,
    agentName: row.name,
    tokens: Number(row.tokens)
  }));

  // Conversations last 7 days
  const conversationsLast7d = await prisma.conversation.count({
    where: {
      userId,
      createdAt: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      }
    }
  });

  // Chart: Token usage per day (7 days)
  const series = await buildRealSeries(userId, "both_in");

  return res.json({
    tokenUsed: Number(plan.tokenUsed),
    tokenLimit: Number(plan.tokenLimit),
    tokenByAgent,
    conversationsLast7d,
    chart: {
      labels: series.labels,
      received: series.seriesA,
      processed: series.seriesB
    }
  });
});

export default router;
