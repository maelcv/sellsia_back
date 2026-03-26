/**
 * Orchestration Logs Routes — Read-only access to orchestration logs.
 *
 * GET /api/orchestration/logs                  — List recent orchestration logs (admin)
 * GET /api/orchestration/stats                 — Aggregate stats (admin)
 * GET /api/orchestration/conversations         — List conversations (admin)
 * GET /api/orchestration/conversations/:id     — Conversation detail with messages + reasoning (admin)
 * GET /api/orchestration/reasoning/:messageId  — Reasoning steps for a single message (admin)
 * GET /api/orchestration/activity              — Paginated activity logs from reasoning_steps (admin)
 * GET /api/orchestration/activity/stats        — Aggregate activity stats (admin)
 */

import express from "express";
import { prisma, getReasoningSteps, getConversationReasoningSteps, getActivityLogs, getActivityStats, getToolUsageLogs } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

// ── GET /api/orchestration/logs — List logs with pagination ──

router.get("/logs", requireAuth, requireRole("admin"), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const countResult = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count FROM orchestration_logs
  `;
  const total = countResult[0]?.count || 0;

  // Use Prisma's safe query builder instead of raw SQL
  const logs = await prisma.orchestrationLog.findMany({
    skip: offset,
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      conversationId: true,
      userId: true,
      userMessage: true,
      detectedIntent: true,
      routingMode: true,
      agentsCalled: true,
      contextType: true,
      contextEntityId: true,
      sellsyDataFetched: true,
      tokensTotal: true,
      responseTimeMs: true,
      error: true,
      createdAt: true,
      user: { select: { email: true } }
    }
  });

  // Transform for API response
  const formattedLogs = logs.map(log => ({
    ...log,
    routingMode: log.routingMode?.replace(/_/g, '-'),
    userEmail: log.user?.email
  }));

  return res.json({
    logs: formattedLogs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// ── GET /api/orchestration/stats — Aggregate stats ──

router.get("/stats", requireAuth, requireRole("admin"), async (_req, res) => {
  const statsResult = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int AS "totalRequests",
      AVG(response_time_ms)::float AS "avgResponseTimeMs",
      SUM(tokens_total)::int AS "totalTokens",
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)::int AS "errorCount",
      SUM(CASE WHEN sellsy_data_fetched = true THEN 1 ELSE 0 END)::int AS "sellsyFetches",
      SUM(CASE WHEN routing_mode = 'multi_agent' THEN 1 ELSE 0 END)::int AS "multiAgentRequests"
    FROM orchestration_logs
  `;
  const stats = statsResult[0] || {};

  const byAgent = await prisma.$queryRaw`
    SELECT agents_called AS agent, COUNT(*)::int AS count
    FROM orchestration_logs
    WHERE agents_called IS NOT NULL
    GROUP BY agents_called
    ORDER BY count DESC
  `;

  const byIntent = await prisma.$queryRaw`
    SELECT detected_intent AS intent, COUNT(*)::int AS count
    FROM orchestration_logs
    WHERE detected_intent IS NOT NULL
    GROUP BY detected_intent
    ORDER BY count DESC
  `;

  return res.json({ stats, byAgent, byIntent });
});

// ── GET /api/orchestration/conversations — List conversations (admin) ──

router.get("/conversations", requireAuth, requireRole("admin"), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const countResult = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count FROM conversations
  `;
  const total = countResult[0]?.count || 0;

  const conversations = await prisma.$queryRaw`
    SELECT c.id, c.user_id AS "userId", c.agent_id AS "agentId",
           c.title, c.context_type AS "contextType",
           c.context_entity_id AS "contextEntityId",
           c.context_url AS "contextUrl",
           c.started_at AS "startedAt", c.updated_at AS "updatedAt",
           u.email AS "userEmail", a.name AS "agentName",
           (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS "messageCount"
    FROM conversations c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN agents a ON a.id = c.agent_id
    ORDER BY c.updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return res.json({
    conversations,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// ── GET /api/orchestration/conversations/:id — Conversation detail with messages ──

router.get("/conversations/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;

  const convResult = await prisma.$queryRaw`
    SELECT c.id, c.user_id AS "userId", c.agent_id AS "agentId",
           c.title, c.context_type AS "contextType",
           c.context_entity_id AS "contextEntityId",
           c.context_url AS "contextUrl",
           c.started_at AS "startedAt", c.updated_at AS "updatedAt",
           u.email AS "userEmail", a.name AS "agentName"
    FROM conversations c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN agents a ON a.id = c.agent_id
    WHERE c.id = ${id}
  `;

  const conversation = convResult[0] || null;
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const messages = await prisma.$queryRaw`
    SELECT m.id, m.role::text, m.content, m.agent_id AS "agentId",
           m.tokens_input AS "tokensInput", m.tokens_output AS "tokensOutput",
           m.provider, m.model, m.created_at AS "createdAt",
           m.sources_json AS "sourcesJson",
           a.name AS "agentName",
           mf.rating::text AS "feedbackRating", mf.comment AS "feedbackComment"
    FROM messages m
    LEFT JOIN agents a ON a.id = m.agent_id
    LEFT JOIN message_feedback mf ON mf.message_id = m.id
    WHERE m.conversation_id = ${id}
    ORDER BY m.created_at ASC
  `;

  // Attach reasoning steps to each assistant message
  const reasoningByMessage = {};
  const conversationReasoning = await getConversationReasoningSteps(id);
  for (const step of conversationReasoning) {
    const key = step.message_id || "__unlinked__";
    if (!reasoningByMessage[key]) reasoningByMessage[key] = [];
    reasoningByMessage[key].push(step);
  }

  const messagesWithReasoning = messages.map((msg) => {
    let sourcesUsed = null;
    if (msg.sourcesJson) {
      try { sourcesUsed = JSON.parse(msg.sourcesJson); } catch { sourcesUsed = null; }
    }
    return {
      ...msg,
      sourcesJson: undefined,
      sourcesUsed,
      reasoning: reasoningByMessage[msg.id] || [],
    };
  });

  return res.json({ conversation, messages: messagesWithReasoning });
});

// ── GET /api/orchestration/reasoning/:messageId — Reasoning steps for a single message ──

router.get("/reasoning/:messageId", requireAuth, requireRole("admin"), async (req, res) => {
  const { messageId } = req.params;

  const steps = await getReasoningSteps(Number(messageId));
  return res.json({ steps });
});

// ── GET /api/orchestration/activity — Paginated activity logs from reasoning_steps ──

router.get("/activity", requireAuth, requireRole("admin"), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const stepType = req.query.stepType || null;
  const agentId = req.query.agentId || null;
  const errorsOnly = req.query.errorsOnly === "true";

  const result = await getActivityLogs({ page, limit, stepType, agentId, errorsOnly });
  return res.json(result);
});

// ── GET /api/orchestration/activity/stats — Aggregate activity stats ──

router.get("/activity/stats", requireAuth, requireRole("admin"), async (_req, res) => {
  const result = await getActivityStats();
  return res.json(result);
});

// ── GET /api/orchestration/tool-usage — Paired tool_call + tool_result logs ──
// Returns: Agent, Tool, User, Input, Output, Success Status, timestamps

router.get("/tool-usage", requireAuth, requireRole("admin"), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const agentId = req.query.agentId || null;
  const userId = req.query.userId ? Number(req.query.userId) : null;
  const toolName = req.query.toolName || null;
  const errorsOnly = req.query.errorsOnly === "true";

  const result = await getToolUsageLogs({ page, limit, agentId, userId, toolName, errorsOnly });
  return res.json(result);
});

export default router;
