import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { prisma } from "./prisma.js";
import { globalRateLimit, webhookRateLimit } from "./middleware/security.js";
import authRoutes from "./routes/auth.js";
import agentRoutes from "./routes/agents.js";
import accessRoutes from "./routes/access.js";
import chatRoutes from "./routes/chat.js";
import overviewRoutes from "./routes/overview.js";
import plansRoutes from "./routes/plans.js";
import usersServicesRoutes from "./routes/users-services.js";
import promptsRoutes from "./routes/prompts.js";
import knowledgeRoutes from "./routes/knowledge.js";
import orchestrationRoutes from "./routes/orchestration.js";
import feedbackRoutes from "./routes/feedback.js";
import usageRoutes from "./routes/usage.js";
import whatsappRoutes from "./routes/whatsapp.js";
import remindersRoutes from "./routes/reminders.js";
import invitationsRoutes from "./routes/invitations.js";
import { requireAuth, toCanonicalRole, toLegacyRole } from "./middleware/auth.js";
import { requireWorkspaceContext } from "./middleware/tenant.js";
import workspacesRoutes from "./routes/workspaces.js";
import setupRoutes from "./routes/setup.js";
import userAccessRoutes from "./routes/user-access.js";
import twoFactorRoutes from "./routes/two-factor.js";
import emailRoutes from "./routes/email.js";
import adminSystemEmailRoutes from "./routes/admin-system-email.js";
import calendarRoutes from "./routes/calendar.js";
import crmOperationsRoutes from "./routes/crm-operations.js";
import documentsRoutes from "./routes/documents.js";
import customFieldsRoutes from "./routes/custom-fields.js";
import analyticsRoutes from "./routes/analytics.js";
import integrationsRoutes from "./routes/integrations.js";
import setupProgressRoutes from "./routes/setup-progress.js";
import clientOnboardingRoutes from "./routes/client-onboarding.js";
import agentsManagementRoutes from "./routes/agents-management.js";
import subAgentsRoutes from "./routes/sub-agents.js";
import aiProvidersRoutes from "./routes/ai-providers.js";
import workspaceRolesRoutes from "./routes/workspace-roles.js";
import orgchartRoutes from "./routes/orgchart.js";
import profileSecurityRoutes from "./routes/profile-security.js";
import { startReminderWorker, stopReminderWorker } from "./services/reminders/reminder-service.js";
import { startEnrichmentWorker } from "./workers/enrichment-worker.js";
import { startImportWorker } from "./workers/import-worker.js";
import {
  startMarketReportsWorker,
  stopMarketReportsWorker,
} from "./workers/market-reports-worker.js";
import marketReportsRoutes from "./routes/market-reports.js";
import vaultRoutes from "./routes/vault.js";
import automationsRoutes from "./routes/automations.js";
import projectsRoutes from "./routes/projects.js";
import { startAutomationWorker, stopAutomationWorker } from "./workers/automation-worker.js";

import { startWorkflowQueue, stopWorkflowQueue } from "./workers/workflow-queue.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Trust proxy (for Railway/Vercel reverse proxies)
app.set('trust proxy', 1);

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"]
      }
    }
  })
);

// Private Network Access (PNA)
app.use((req, res, next) => {
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (origin.startsWith("chrome-extension://")) return callback(null, true);
      const allowed = config.corsOrigin.split(",").map((s) => s.trim());
      if (allowed.includes(origin) || allowed.includes("*")) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

app.use(globalRateLimit);

// Rate-limit public webhook endpoints before any body parsing
app.use("/api/whatsapp/webhook", webhookRateLimit);
app.use("/api/whatsapp/twilio-webhook", webhookRateLimit);

// Capture raw body for WhatsApp webhook signature validation
app.use("/api/whatsapp/webhook", express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

app.use(express.json({ limit: "1mb" }));
app.use(morgan("combined"));

// Set timeouts for long-running AI operations (configurable via env)
app.use((req, res, next) => {
  if (req.path === "/api/chat/stream") {
    req.setTimeout(config.chatStreamTimeoutMs);
    res.setTimeout(config.chatStreamTimeoutMs);
  } else if (req.path === "/api/chat/ask") {
    req.setTimeout(config.chatAskTimeoutMs);
    res.setTimeout(config.chatAskTimeoutMs);
  }
  next();
});

app.get("/api/health", async (_req, res) => {
  const services = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    services.db = "ok";
  } catch {
    services.db = "unavailable";
  }
  try {
    const { getRedis } = await import("./cache/redis-client.js");
    const redis = await getRedis();
    if (redis) {
      await redis.ping();
      services.redis = "ok";
    } else {
      services.redis = process.env.REDIS_URL ? "unavailable" : "not_configured";
    }
  } catch {
    services.redis = "unavailable";
  }
  const criticalServices = ["db"];
  const status = criticalServices.every((s) => services[s] === "ok") ? "ok" : "degraded";
  res.status(status === "ok" ? 200 : 503).json({ status, service: "boatswain-dashboard-api", services });
});

app.use("/api/auth", authRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/access", accessRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/overview", overviewRoutes);
app.use("/api/plans", plansRoutes);
app.use("/api/users-services", usersServicesRoutes);
app.use("/api/prompts", promptsRoutes);
app.use("/api/knowledge", knowledgeRoutes);
app.use("/api/orchestration", orchestrationRoutes);
app.use("/api/feedback", feedbackRoutes);
app.use("/api/usage", usageRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/reminders", remindersRoutes);
app.use("/api/invitations", invitationsRoutes);
app.use("/api/workspaces", workspacesRoutes);
app.use("/api/user-access", userAccessRoutes);
app.use("/api/2fa", twoFactorRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/admin/system-email", adminSystemEmailRoutes);
app.use("/api/calendar", calendarRoutes);
app.use("/api/crm", crmOperationsRoutes);
app.use("/api/documents", documentsRoutes);
app.use("/api/custom-fields", customFieldsRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/setup", setupRoutes);
app.use("/api/setup", setupProgressRoutes);
app.use("/api/onboarding", clientOnboardingRoutes);
app.use("/api/agents-management", agentsManagementRoutes);
app.use("/api/sub-agents", subAgentsRoutes);
app.use("/api/ai-providers", aiProvidersRoutes);
app.use("/api/workspace-roles", workspaceRolesRoutes);
app.use("/api/onboarding/orgchart", orgchartRoutes);
app.use("/api/profile", profileSecurityRoutes);
app.use("/api/market-reports", marketReportsRoutes);
app.use("/api/vault", vaultRoutes);
app.use("/api/automations", automationsRoutes);
app.use("/api/projects", projectsRoutes);


app.get("/api/me", requireAuth, requireWorkspaceContext, async (req, res) => {
  // Enrich with fields not in JWT (like twoFactorEnabled)
  const dbUser = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { twoFactorEnabled: true, workspaceId: true, role: true },
  });

  const canonicalRole = toCanonicalRole(dbUser?.role || req.user?.roleCanonical || req.user?.role);
  const legacyRole = toLegacyRole(canonicalRole);

  res.json({
    user: { 
      ...req.user,
      role: canonicalRole,
      roleLegacy: legacyRole,
      twoFactorEnabled: dbUser?.twoFactorEnabled ?? false,
      workspaceId: dbUser?.workspaceId || null
    },
    tenantPlan: req.workspacePlan,
    tenantParentId: req.workspaceParentId
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Prevent unhandled async errors from crashing the process
process.on("unhandledRejection", (err) => {
  console.error("[Server] Unhandled rejection:", err);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[Server] SIGTERM received, disconnecting Prisma...");
  stopReminderWorker();
  stopMarketReportsWorker();
  stopAutomationWorker();
  await stopWorkflowQueue();
  await prisma.$disconnect();
  process.exit(0);
});

// ── Global Error Handler (Prisma, Database, etc.) ──
app.use((err, req, res, next) => {
  console.error("[ERROR]", err?.code || err?.name || "Unknown", err.message);

  // Prisma errors
  if (err?.code === "P2002") {
    return res.status(409).json({ error: "Unique constraint violation" });
  }
  if (err?.code === "P2025") {
    return res.status(404).json({ error: "Record not found" });
  }
  if (err?.message?.includes("Tenant or user not found")) {
    return res.status(403).json({ error: "Access denied: insufficient permissions" });
  }

  // Default 500 error
  return res.status(500).json({
    error: "Internal Server Error",
    message: process.env.NODE_ENV === "development" ? err.message : "An unexpected error occurred"
  });
});

app.listen(config.port, () => {
  console.log(`Boatswain dashboard API listening on http://localhost:${config.port}`);
  // Démarrer tous les workers après que le serveur est prêt
  startReminderWorker();
  startMarketReportsWorker(prisma).catch((err) =>
    console.error("[Server] market reports worker failed to start:", err)
  );
  startEnrichmentWorker();
  startImportWorker();
  startWorkflowQueue().catch((err) =>
    console.error("[Server] workflow queue failed to start:", err)
  );
  startAutomationWorker().catch((err) =>
    console.error("[Server] automation worker failed to start:", err)
  );
});
