/**
 * routes/analytics.js
 *
 * Phase 5: Analytics aggregation + reporting
 * Feature flag: analytics
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { requireFeature } from "../middleware/auth.js";
import { prisma } from "../prisma.js";

const router = Router();
router.use(requireAuth, requireWorkspaceContext, requireFeature("analytics"));

// GET /api/analytics/summary
router.get("/summary", async (req, res) => {
  const days = parseInt(req.query.days || "30", 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [conversations, toolCalls, totalTokens, totalCost] = await Promise.all([
    prisma.analyticsLog.count({
      where: { userId: req.user.sub, eventType: "conversation", createdAt: { gte: since } },
    }),
    prisma.analyticsLog.count({
      where: { userId: req.user.sub, eventType: "tool_call", createdAt: { gte: since } },
    }),
    prisma.analyticsLog.aggregate({
      where: { userId: req.user.sub, createdAt: { gte: since } },
      _sum: { tokensUsed: true },
    }),
    prisma.analyticsLog.aggregate({
      where: { userId: req.user.sub, createdAt: { gte: since } },
      _sum: { costEstimate: true },
    }),
  ]);

  res.json({
    period: `${days} days`,
    conversations,
    toolCalls,
    totalTokens: totalTokens._sum.tokensUsed || 0,
    totalCostCents: (totalCost._sum.costEstimate || 0) / 100,
  });
});

// GET /api/analytics/events
router.get("/events", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const events = await prisma.analyticsLog.findMany({
    where: { userId: req.user.sub },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json({ events });
});

export default router;
