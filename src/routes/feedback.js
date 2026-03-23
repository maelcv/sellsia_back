/**
 * Feedback Routes — Admin review & improvement loop.
 *
 * GET  /api/feedback           — List negative feedback with conversation context (admin)
 * PUT  /api/feedback/:id/review — Mark feedback as reviewed (admin)
 * POST /api/feedback/:id/to-knowledge — Convert feedback into a knowledge document (admin)
 */

import express from "express";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

// ══════════════════════════════════════════════════════
// GET /api/feedback — List negative feedback with context
// ══════════════════════════════════════════════════════

router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { status, agent_id, limit = 100 } = req.query;
  const limitNum = Math.min(Number(limit) || 100, 500);

  // Build dynamic query with conditions
  const conditions = ["mf.rating = 'negative'"];
  const params = [];
  let paramIdx = 1;

  if (status) {
    conditions.push(`mf.review_status = $${paramIdx++}::text::"ReviewStatus"`);
    params.push(status);
  }

  if (agent_id) {
    conditions.push(`m.agent_id = $${paramIdx++}`);
    params.push(agent_id);
  }

  const whereClause = conditions.join(" AND ");

  const feedback = await prisma.$queryRawUnsafe(
    `SELECT
      mf.id,
      mf.message_id AS "message_id",
      mf.rating::text,
      mf.category::text,
      mf.comment,
      mf.review_status AS "review_status",
      mf.created_at,
      u.email AS "user_email",
      m.content AS "agent_response",
      m.agent_id,
      m.conversation_id,
      a.name AS "agent_name",
      (
        SELECT content FROM messages
        WHERE conversation_id = m.conversation_id
          AND role = 'user'
          AND created_at <= m.created_at
        ORDER BY created_at DESC LIMIT 1
      ) AS "user_message"
    FROM message_feedback mf
    JOIN messages m ON m.id = mf.message_id
    JOIN users u ON u.id = mf.user_id
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE ${whereClause}
    ORDER BY mf.created_at DESC
    LIMIT $${paramIdx}`,
    ...params, limitNum
  );

  // Global stats
  const statsResult = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END)::int AS pending,
      SUM(CASE WHEN review_status = 'reviewed' THEN 1 ELSE 0 END)::int AS reviewed
    FROM message_feedback
    WHERE rating = 'negative'
  `;
  const stats = statsResult[0] || { total: 0, pending: 0, reviewed: 0 };

  // Breakdown by category
  const byCategory = await prisma.$queryRaw`
    SELECT category::text, COUNT(*)::int AS count
    FROM message_feedback
    WHERE rating = 'negative' AND category IS NOT NULL
    GROUP BY category
    ORDER BY count DESC
  `;

  // Breakdown by agent
  const byAgent = await prisma.$queryRaw`
    SELECT m.agent_id, a.name AS "agent_name", COUNT(*)::int AS count
    FROM message_feedback mf
    JOIN messages m ON m.id = mf.message_id
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE mf.rating = 'negative'
    GROUP BY m.agent_id, a.name
    ORDER BY count DESC
  `;

  return res.json({ feedback, stats, byCategory, byAgent });
});

// ══════════════════════════════════════════════════════
// PUT /api/feedback/:id/review — Mark as reviewed
// ══════════════════════════════════════════════════════

router.put("/:id/review", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.messageFeedback.update({
      where: { id },
      data: { reviewStatus: "reviewed" }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Feedback not found" });
    }
    throw err;
  }

  return res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// POST /api/feedback/:id/to-knowledge — Convert to KB doc
// ══════════════════════════════════════════════════════

router.post("/:id/to-knowledge", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const { title, content, agentId } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: "title and content are required" });
  }

  const feedback = await prisma.messageFeedback.findUnique({ where: { id } });
  if (!feedback) return res.status(404).json({ error: "Feedback not found" });

  // Create the knowledge document
  const doc = await prisma.knowledgeDocument.create({
    data: {
      title,
      content,
      docType: "faq",
      agentId: agentId || null,
      metadataJson: JSON.stringify({ source: "feedback", feedback_id: id }),
      updatedAt: new Date()
    }
  });

  // Mark feedback as reviewed
  await prisma.messageFeedback.update({
    where: { id },
    data: { reviewStatus: "reviewed" }
  });

  return res.json({ ok: true, docId: doc.id });
});

export default router;
