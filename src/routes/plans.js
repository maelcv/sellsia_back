import express from "express";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

const changePlanSchema = z.object({
  planId: z.number().int().positive()
});

const upsertPlanSchema = z.object({
  name: z.string().min(2).max(80),
  monthlyTokenLimit: z.number().int().min(1000).max(100000000),
  collaboratorLimit: z.number().int().min(1).max(10000),
  priceEurMonth: z.number().min(0).max(1000000),
  features: z.array(z.string().min(2).max(120)).min(1).max(30),
  isActive: z.boolean().optional().default(true)
});

router.get("/my-plan", requireAuth, requireRole("client"), async (req, res) => {
  const userId = req.user.sub;

  const clientPlan = await prisma.clientPlan.findUnique({
    where: { userId },
    include: {
      plan: true
    }
  });

  if (!clientPlan) {
    return res.status(404).json({ error: "No plan assigned" });
  }

  const plan = clientPlan.plan;

  return res.json({
    plan: {
      id: plan.id,
      name: plan.name,
      monthlyTokenLimit: plan.monthlyTokenLimit,
      collaboratorLimit: plan.collaboratorLimit,
      priceEurMonth: plan.priceEurMonth,
      features: JSON.parse(plan.featuresJson),
      tokenUsed: clientPlan.tokenUsed,
      tokenRemaining: Math.max(0, plan.monthlyTokenLimit - clientPlan.tokenUsed),
      tokenReceived: clientPlan.tokenReceived,
      tokenProcessed: clientPlan.tokenProcessed,
      tokenSent: clientPlan.tokenSent,
      tokenReturned: clientPlan.tokenReturned
    }
  });
});

router.get("/catalog", requireAuth, async (req, res) => {
  const plans = await prisma.plan.findMany({
    orderBy: { priceEurMonth: "asc" }
  });

  const mapped = plans.map((row) => ({
    id: row.id,
    name: row.name,
    monthlyTokenLimit: row.monthlyTokenLimit,
    collaboratorLimit: row.collaboratorLimit,
    priceEurMonth: row.priceEurMonth,
    featuresJson: row.featuresJson,
    isActive: row.isActive,
    features: JSON.parse(row.featuresJson)
  }));

  if (req.user.role === "admin") {
    return res.json({ plans: mapped });
  }

  return res.json({ plans: mapped.filter((p) => p.isActive) });
});

router.post("/change-plan", requireAuth, requireRole("client"), async (req, res) => {
  const parse = changePlanSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const plan = await prisma.plan.findFirst({
    where: { id: parse.data.planId, isActive: true }
  });

  if (!plan) {
    return res.status(404).json({ error: "Plan not found or inactive" });
  }

  await prisma.clientPlan.upsert({
    where: { userId: req.user.sub },
    create: {
      userId: req.user.sub,
      planId: parse.data.planId
    },
    update: {
      planId: parse.data.planId,
      updatedAt: new Date()
    }
  });

  await logAudit(req.user.sub, "PLAN_CHANGED", { planId: parse.data.planId });
  return res.json({ message: "Plan updated" });
});

router.post("/admin", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = upsertPlanSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const payload = parse.data;

  await prisma.plan.create({
    data: {
      name: payload.name,
      monthlyTokenLimit: payload.monthlyTokenLimit,
      collaboratorLimit: payload.collaboratorLimit,
      priceEurMonth: payload.priceEurMonth,
      featuresJson: JSON.stringify(payload.features),
      isActive: payload.isActive
    }
  });

  await logAudit(req.user.sub, "PLAN_CREATED", { name: payload.name });
  return res.status(201).json({ message: "Plan created" });
});

router.patch("/admin/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const planId = Number(req.params.id);
  if (!Number.isInteger(planId) || planId <= 0) {
    return res.status(400).json({ error: "Invalid plan id" });
  }

  const parse = upsertPlanSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const payload = parse.data;

  try {
    await prisma.plan.update({
      where: { id: planId },
      data: {
        name: payload.name,
        monthlyTokenLimit: payload.monthlyTokenLimit,
        collaboratorLimit: payload.collaboratorLimit,
        priceEurMonth: payload.priceEurMonth,
        featuresJson: JSON.stringify(payload.features),
        isActive: payload.isActive
      }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Plan not found" });
    }
    throw err;
  }

  await logAudit(req.user.sub, "PLAN_UPDATED", { planId });
  return res.json({ message: "Plan updated" });
});

export default router;
