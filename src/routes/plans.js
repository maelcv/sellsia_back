import express from "express";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireTenantContext } from "../middleware/tenant.js";

const router = express.Router();

// Toutes les clés de permissions features supportées
const PERMISSION_KEYS = [
  "ai_provider",
  "agents_local",
  "agents_cloud",
  "knowledge_base",
  "feedback",
  "logs",
  "crm_services",
  "channel_services",
  "sub_clients",
  "user_profiles",
  "reminders",
  "usage_stats",
  "orchestration_logs"
];

const ALL_TRUE_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));

const changePlanSchema = z.object({
  planId: z.number().int().positive()
});

const upsertPlanSchema = z.object({
  name: z.string().min(2).max(80),
  monthlyTokenLimit: z.number().int().min(1000).max(100000000),
  collaboratorLimit: z.number().int().min(1).max(10000),
  priceEurMonth: z.number().min(0).max(1000000),
  features: z.array(z.string().min(2).max(120)).min(1).max(30),
  isActive: z.boolean().optional().default(true),
  // Permissions features (optionnel, défaut: toutes false)
  permissions: z.record(z.string(), z.boolean()).optional().default({}),
  maxSubClients: z.number().int().min(0).max(10000).optional().default(0),
  maxUsers: z.number().int().min(1).max(100000).optional().default(10),
  maxAgents: z.number().int().min(0).max(1000).optional().default(5)
});

/**
 * GET /api/plans/feature-access
 * Retourne les permissions features effectives pour le tenant courant.
 * - Admin : toutes les features activées
 * - Client/collaborator : permissions du plan du workspace
 */
router.get("/feature-access", requireAuth, requireTenantContext, async (req, res) => {
  if (req.user.role === "admin") {
    return res.json({
      permissions: ALL_TRUE_PERMISSIONS,
      isAdmin: true,
      plan: null,
      quotas: { maxSubClients: 9999, maxUsers: 9999, maxAgents: 9999 }
    });
  }

  const plan = req.tenantPlan;
  return res.json({
    permissions: plan?.permissions || {},
    isAdmin: false,
    plan: plan ? { id: plan.id, name: plan.name } : null,
    quotas: plan
      ? {
          maxSubClients: plan.maxSubClients,
          maxUsers: plan.maxUsers,
          maxAgents: plan.maxAgents
        }
      : { maxSubClients: 0, maxUsers: 0, maxAgents: 0 }
  });
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
    features: JSON.parse(row.featuresJson),
    permissions: (() => { try { return JSON.parse(row.permissionsJson || "{}"); } catch { return {}; } })(),
    maxSubClients: row.maxSubClients,
    maxUsers: row.maxUsers,
    maxAgents: row.maxAgents
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
      isActive: payload.isActive,
      permissionsJson: JSON.stringify(payload.permissions || {}),
      maxSubClients: payload.maxSubClients ?? 0,
      maxUsers: payload.maxUsers ?? 10,
      maxAgents: payload.maxAgents ?? 5
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
        isActive: payload.isActive,
        permissionsJson: JSON.stringify(payload.permissions || {}),
        maxSubClients: payload.maxSubClients ?? 0,
        maxUsers: payload.maxUsers ?? 10,
        maxAgents: payload.maxAgents ?? 5
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
