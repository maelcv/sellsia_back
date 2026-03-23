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

router.get("/client", requireAuth, requireRole("client", "collaborator"), async (req, res) => {
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
  const activeClientsResult = await prisma.$queryRaw`
    SELECT COUNT(*)::int as count FROM users
    WHERE role = 'client' AND id IN (
      SELECT user_id FROM client_plans WHERE sellsy_connection_status = 'active'
    )`;
  const activeClients = activeClientsResult[0]?.count || 0;

  const totalClients = await prisma.user.count({
    where: { role: "client" }
  });

  const tokenRow = await prisma.$queryRaw`
    SELECT COALESCE(SUM(token_received), 0)::int as "tokenReceived",
           COALESCE(SUM(token_sent), 0)::int as "tokenSent",
           COALESCE(SUM(token_processed), 0)::int as "tokenProcessed",
           COALESCE(SUM(token_returned), 0)::int as "tokenReturned"
    FROM client_plans`;

  const tokenAgg = tokenRow[0] || { tokenReceived: 0, tokenSent: 0, tokenProcessed: 0, tokenReturned: 0 };

  const messageTokenRow = await prisma.$queryRaw`
    SELECT COALESCE(SUM(tokens_input), 0)::int as "tokensInput",
           COALESCE(SUM(tokens_output), 0)::int as "tokensOutput"
    FROM messages
    WHERE role = 'assistant'`;

  const messageTokenAgg = messageTokenRow[0] || { tokensInput: 0, tokensOutput: 0 };

  const tokenReceived = tokenAgg.tokenReceived || Number(messageTokenAgg.tokensInput);
  const tokenSent = tokenAgg.tokenSent || Number(messageTokenAgg.tokensInput);
  const tokenProcessed = tokenAgg.tokenProcessed || (Number(messageTokenAgg.tokensInput) + Number(messageTokenAgg.tokensOutput));
  const tokenReturned = tokenAgg.tokenReturned || Number(messageTokenAgg.tokensOutput);

  const pendingRequests = await prisma.accessRequest.count({
    where: { status: "pending" }
  });

  const graphIn = await buildRealSeries(null, "both_in");
  const graphOut = await buildRealSeries(null, "both_out");

  return res.json({
    cards: {
      activeClients,
      totalClients,
      tokenReceived,
      tokenSent,
      pendingRequests
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

export default router;
