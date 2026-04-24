/**
 * Usage Routes — Token usage tracking and analytics.
 *
 * GET /api/usage/summary       — Aggregated usage by period
 * GET /api/usage/by-provider   — Usage grouped by provider
 * GET /api/usage/by-agent      — Usage grouped by agent
 * GET /api/usage/by-user       — Usage grouped by user (admin only)
 * GET /api/usage/export        — Export usage data as CSV
 */

import express from "express";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

// ── GET /api/usage/summary — Aggregated usage ──

router.get("/summary", requireAuth, requireRole("admin"), async (req, res) => {
  const { period = "day", days = 30 } = req.query;
  const daysNum = Math.min(Number(days) || 30, 365);

  let dateFormat;
  switch (period) {
    case "month": dateFormat = "YYYY-MM"; break;
    case "week": dateFormat = "IYYY-\"W\"IW"; break;
    default: dateFormat = "YYYY-MM-DD";
  }

  const rows = await prisma.$queryRaw`
    SELECT
      to_char(created_at, ${dateFormat}) AS period,
      SUM(tokens_input)::int AS "totalInput",
      SUM(tokens_output)::int AS "totalOutput",
      SUM(tokens_input + tokens_output)::int AS "totalTokens",
      COUNT(*)::int AS "callCount"
    FROM token_usage
    WHERE created_at >= NOW() - make_interval(days => ${daysNum})
    GROUP BY period
    ORDER BY period DESC`;

  const totalsResult = await prisma.$queryRaw`
    SELECT
      COALESCE(SUM(tokens_input), 0)::int AS "totalInput",
      COALESCE(SUM(tokens_output), 0)::int AS "totalOutput",
      COALESCE(SUM(tokens_input + tokens_output), 0)::int AS "totalTokens",
      COUNT(*)::int AS "callCount"
    FROM token_usage
    WHERE created_at >= NOW() - make_interval(days => ${daysNum})`;
  const totals = totalsResult[0] || { totalInput: 0, totalOutput: 0, totalTokens: 0, callCount: 0 };

  return res.json({ periods: rows, totals });
});

// ── GET /api/usage/by-provider — Usage by provider ──

router.get("/by-provider", requireAuth, requireRole("admin"), async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);

  const rows = await prisma.$queryRaw`
    SELECT
      COALESCE(provider_code, 'unknown') AS provider,
      SUM(tokens_input)::int AS "totalInput",
      SUM(tokens_output)::int AS "totalOutput",
      SUM(tokens_input + tokens_output)::int AS "totalTokens",
      COUNT(*)::int AS "callCount"
    FROM token_usage
    WHERE created_at >= NOW() - make_interval(days => ${days})
    GROUP BY provider_code
    ORDER BY "totalTokens" DESC`;

  return res.json({ providers: rows });
});

// ── GET /api/usage/by-agent — Usage by agent ──

router.get("/by-agent", requireAuth, requireRole("admin"), async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);

  const rows = await prisma.$queryRaw`
    SELECT
      COALESCE(tu.agent_id, 'unknown') AS "agentId",
      COALESCE(a.name, tu.agent_id) AS "agentName",
      tu.sub_agent_type AS "subAgentType",
      SUM(tu.tokens_input)::int AS "totalInput",
      SUM(tu.tokens_output)::int AS "totalOutput",
      SUM(tu.tokens_input + tu.tokens_output)::int AS "totalTokens",
      COUNT(*)::int AS "callCount"
    FROM token_usage tu
    LEFT JOIN agents a ON a.id = tu.agent_id
    WHERE tu.created_at >= NOW() - make_interval(days => ${days})
    GROUP BY tu.agent_id, tu.sub_agent_type, a.name
    ORDER BY "totalTokens" DESC`;

  return res.json({ agents: rows });
});

// ── GET /api/usage/by-user — Usage by user (admin only) ──

router.get("/by-user", requireAuth, requireRole("admin"), async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);

  const rows = await prisma.$queryRaw`
    SELECT
      tu.user_id AS "userId",
      u.email,
      u.company_name AS company,
      SUM(tu.tokens_input)::int AS "totalInput",
      SUM(tu.tokens_output)::int AS "totalOutput",
      SUM(tu.tokens_input + tu.tokens_output)::int AS "totalTokens",
      COUNT(*)::int AS "callCount"
    FROM token_usage tu
    LEFT JOIN users u ON u.id = tu.user_id
    WHERE tu.created_at >= NOW() - make_interval(days => ${days})
    GROUP BY tu.user_id, u.email, u.company_name
    ORDER BY "totalTokens" DESC`;

  return res.json({ users: rows });
});

// ── GET /api/usage/export — Export as CSV ──

router.get("/export", requireAuth, requireRole("admin"), async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);

  const rows = await prisma.$queryRaw`
    SELECT
      tu.created_at AS date,
      u.email AS "user",
      tu.agent_id AS agent,
      tu.sub_agent_type AS "subAgent",
      tu.provider_code AS provider,
      tu.tokens_input AS "tokensInput",
      tu.tokens_output AS "tokensOutput",
      (tu.tokens_input + tu.tokens_output) AS "tokensTotal",
      tu.conversation_id AS "conversationId"
    FROM token_usage tu
    LEFT JOIN users u ON u.id = tu.user_id
    WHERE tu.created_at >= NOW() - make_interval(days => ${days})
    ORDER BY tu.created_at DESC`;

  const header = "date,user,agent,sub_agent,provider,tokens_input,tokens_output,tokens_total,conversation_id\n";
  const csvRows = rows.map(r =>
    `${r.date},${r.user || ""},${r.agent || ""},${r.subAgent || ""},${r.provider || ""},${r.tokensInput},${r.tokensOutput},${r.tokensTotal},${r.conversationId || ""}`
  ).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=token-usage-${days}d.csv`);
  return res.send(header + csvRows);
});

export default router;
