/**
 * Prisma Client singleton + helper functions (replaces db.js).
 * All database access goes through this module.
 */

import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  datasources: {
    db: {
      url: (() => {
        const base = process.env.DATABASE_URL || "postgresql://localhost:5432/boatswain";
        // PgBouncer in Session mode caps real connections — limit Prisma pool aggressively
        const url = new URL(base);
        if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "5");
        if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "10");
        return url.toString();
      })(),
    },
  },
});

// ── Helper functions ──

export async function hasAnyUsers() {
  try {
    const count = await prisma.user.count();
    return count > 0;
  } catch (err) {
    // If RLS policies prevent access due to missing tenant/user context, assume no users exist
    if (err?.message?.includes("Tenant or user not found") || err?.message?.includes("FATAL")) {
      return false;
    }
    throw err;
  }
}

export async function logAudit(actorUserId, action, details = null) {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        details: details ? JSON.stringify(details) : null
      }
    });
  } catch (err) {
    console.error("logAudit failed:", err.message, { actorUserId, action });
  }
}

export async function logTokenUsage({ userId, agentId = null, providerCode = null, subAgentType = null, conversationId = null, tokensInput = 0, tokensOutput = 0 }) {
  try {
    await prisma.tokenUsage.create({
      data: {
        userId,
        agentId,
        providerCode,
        subAgentType,
        conversationId,
        tokensInput,
        tokensOutput
      }
    });
  } catch (err) {
    console.error("logTokenUsage failed:", err.message);
  }
}

export async function logReasoningStep({ conversationId, messageId = null, stepType, agentId = null, data = {} }) {
  try {
    const validAgentIds = ["commercial", "directeur", "technicien"];
    const sqlAgentId = validAgentIds.includes(agentId) ? agentId : null;

    const result = await prisma.reasoningStep.create({
      data: {
        conversationId,
        messageId,
        stepType,
        agentId: sqlAgentId,
        dataJson: JSON.stringify(data)
      }
    });
    return result.id;
  } catch (err) {
    console.error("logReasoningStep failed:", err.message, { conversationId, stepType });
    return null;
  }
}

export async function linkReasoningStepsToMessage(conversationId, messageId) {
  try {
    const result = await prisma.reasoningStep.updateMany({
      where: {
        conversationId,
        messageId: null
      },
      data: {
        messageId
      }
    });
    return result.count;
  } catch (err) {
    console.error("linkReasoningStepsToMessage failed:", err.message, { conversationId, messageId });
    return 0;
  }
}

export async function logProviderError({ providerCode, errorType = "unknown", httpStatus = null, errorMessage = "", conversationId = null, agentId = null, userId, rawError = null }) {
  try {
    const result = await prisma.providerError.create({
      data: {
        providerCode,
        errorType,
        httpStatus,
        errorMessage,
        conversationId,
        agentId,
        userId,
        rawErrorJson: rawError ? JSON.stringify(rawError) : null
      }
    });
    return result.id;
  } catch (err) {
    console.error("logProviderError failed:", err.message, { providerCode, errorType });
    return null;
  }
}

export async function getActivityLogs({ page = 1, limit = 50, stepType = null, agentId = null, errorsOnly = false } = {}) {
  const where = {};
  if (stepType) where.stepType = stepType;
  if (agentId) where.agentId = agentId;
  if (errorsOnly) {
    where.OR = [
      { stepType: "error" },
      {
        stepType: "tool_result",
        dataJson: { contains: '"success":false' }
      }
    ];
  }

  const offset = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    prisma.reasoningStep.count({ where }),
    prisma.reasoningStep.findMany({
      where,
      include: {
        agent: { select: { name: true } },
        conversation: {
          select: {
            title: true,
            user: { select: { email: true } }
          }
        }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: limit
    })
  ]);

  return {
    logs: rows.map((row) => ({
      id: row.id,
      conversation_id: row.conversationId,
      message_id: row.messageId,
      step_type: row.stepType,
      agent_id: row.agentId,
      agent_name: row.agent?.name || null,
      conversation_title: row.conversation?.title || null,
      user_email: row.conversation?.user?.email || null,
      data_json: row.dataJson,
      data: row.dataJson ? JSON.parse(row.dataJson) : {},
      created_at: row.createdAt
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
}

export async function getActivityStats() {
  const stats = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int as "totalSteps",
      SUM(CASE WHEN step_type = 'tool_call' THEN 1 ELSE 0 END)::int as "totalToolCalls",
      SUM(CASE WHEN step_type = 'tool_result' AND data_json::jsonb->>'success' = 'true' THEN 1 ELSE 0 END)::int as "toolSuccesses",
      SUM(CASE WHEN step_type = 'tool_result' AND data_json::jsonb->>'success' = 'false' THEN 1 ELSE 0 END)::int as "toolFailures",
      SUM(CASE WHEN step_type = 'error' THEN 1 ELSE 0 END)::int as "totalErrors",
      SUM(CASE WHEN step_type = 'classification' THEN 1 ELSE 0 END)::int as "totalClassifications",
      SUM(CASE WHEN step_type = 'final_response' THEN 1 ELSE 0 END)::int as "totalResponses"
    FROM reasoning_steps
  `;

  const byTool = await prisma.$queryRaw`
    SELECT data_json::jsonb->>'toolName' as "toolName",
           COUNT(*)::int as calls,
           SUM(CASE WHEN step_type = 'tool_result' AND data_json::jsonb->>'success' = 'true' THEN 1 ELSE 0 END)::int as successes,
           SUM(CASE WHEN step_type = 'tool_result' AND data_json::jsonb->>'success' = 'false' THEN 1 ELSE 0 END)::int as failures
    FROM reasoning_steps
    WHERE step_type IN ('tool_call', 'tool_result') AND data_json::jsonb->>'toolName' IS NOT NULL
    GROUP BY data_json::jsonb->>'toolName'
    ORDER BY calls DESC
  `;

  const byAgent = await prisma.$queryRaw`
    SELECT rs.agent_id as "agentId", a.name as "agentName", COUNT(*)::int as steps,
           SUM(CASE WHEN rs.step_type = 'error' THEN 1 ELSE 0 END)::int as errors
    FROM reasoning_steps rs
    LEFT JOIN agents a ON a.id = rs.agent_id
    WHERE rs.agent_id IS NOT NULL
    GROUP BY rs.agent_id, a.name
    ORDER BY steps DESC
  `;

  return { stats: stats[0] || {}, byTool, byAgent };
}

export async function getToolUsageLogs({ page = 1, limit = 50, agentId = null, userId = null, toolName = null, errorsOnly = false } = {}) {
  const conditions = ["tc.step_type = 'tool_call'"];
  const params = [];
  let paramIdx = 1;

  if (agentId) {
    conditions.push(`tc.agent_id = $${paramIdx++}`);
    params.push(agentId);
  }
  if (userId) {
    conditions.push(`c.user_id = $${paramIdx++}`);
    params.push(userId);
  }
  if (toolName) {
    conditions.push(`tc.data_json::jsonb->>'toolName' = $${paramIdx++}`);
    params.push(toolName);
  }
  if (errorsOnly) {
    conditions.push("(tr.id IS NULL OR tr.data_json::jsonb->>'success' = 'false')");
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (page - 1) * limit;

  const countResult = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int as count
     FROM reasoning_steps tc
     LEFT JOIN reasoning_steps tr ON tr.conversation_id = tc.conversation_id
       AND tr.step_type = 'tool_result'
       AND tr.data_json::jsonb->>'toolName' = tc.data_json::jsonb->>'toolName'
       AND tr.id > tc.id
       AND tr.id = (
         SELECT MIN(sub.id) FROM reasoning_steps sub
         WHERE sub.conversation_id = tc.conversation_id
           AND sub.step_type = 'tool_result'
           AND sub.data_json::jsonb->>'toolName' = tc.data_json::jsonb->>'toolName'
           AND sub.id > tc.id
       )
     LEFT JOIN conversations c ON c.id = tc.conversation_id
     ${whereClause}`,
    ...params
  );

  const total = countResult[0]?.count || 0;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       tc.id as id,
       tc.conversation_id as "conversationId",
       tc.agent_id as "agentId",
       a.name as "agentName",
       c.user_id as "userId",
       u.email as "userEmail",
       tc.data_json::jsonb->>'toolName' as "toolName",
       tc.data_json::jsonb->>'toolArgs' as "toolArgsJson",
       (tc.data_json::jsonb->>'iteration')::int as iteration,
       (tr.data_json::jsonb->>'success')::boolean as success,
       tr.data_json::jsonb->>'error' as error,
       tr.data_json::jsonb->>'resultPreview' as "resultPreview",
       tc.created_at as "calledAt",
       tr.created_at as "resultAt"
     FROM reasoning_steps tc
     LEFT JOIN reasoning_steps tr ON tr.conversation_id = tc.conversation_id
       AND tr.step_type = 'tool_result'
       AND tr.data_json::jsonb->>'toolName' = tc.data_json::jsonb->>'toolName'
       AND tr.id > tc.id
       AND tr.id = (
         SELECT MIN(sub.id) FROM reasoning_steps sub
         WHERE sub.conversation_id = tc.conversation_id
           AND sub.step_type = 'tool_result'
           AND sub.data_json::jsonb->>'toolName' = tc.data_json::jsonb->>'toolName'
           AND sub.id > tc.id
       )
     LEFT JOIN conversations c ON c.id = tc.conversation_id
     LEFT JOIN agents a ON a.id = tc.agent_id
     LEFT JOIN users u ON u.id = c.user_id
     ${whereClause}
     ORDER BY tc.created_at DESC, tc.id DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    ...params, limit, offset
  );

  return {
    logs: rows.map((row) => {
      let toolArgs = null;
      try { toolArgs = row.toolArgsJson ? JSON.parse(row.toolArgsJson) : null; } catch { toolArgs = row.toolArgsJson; }
      return { ...row, toolArgs, toolArgsJson: undefined };
    }),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
}

export async function getReasoningSteps(messageId) {
  const rows = await prisma.reasoningStep.findMany({
    where: { messageId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  return rows.map((row) => ({
    ...row,
    data: row.dataJson ? JSON.parse(row.dataJson) : {}
  }));
}

export async function getConversationReasoningSteps(conversationId) {
  const rows = await prisma.reasoningStep.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  return rows.map((row) => ({
    id: row.id,
    conversation_id: row.conversationId,
    message_id: row.messageId,
    step_type: row.stepType,
    agent_id: row.agentId,
    data_json: row.dataJson,
    data: row.dataJson ? JSON.parse(row.dataJson) : {},
    created_at: row.createdAt
  }));
}
