import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { prisma } from "./prisma.js";
import { globalRateLimit } from "./middleware/security.js";
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
import { requireAuth } from "./middleware/auth.js";
import { startReminderWorker, stopReminderWorker } from "../ia_models/reminders/reminder-service.js";

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
        styleSrc: ["'self'", "'unsafe-inline'"],
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

// Capture raw body for WhatsApp webhook signature validation
app.use("/api/whatsapp/webhook", express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

app.use(express.json({ limit: "1mb" }));
app.use(morgan("combined"));

// Set aggressive timeouts for long-running AI operations
app.use((req, res, next) => {
  if (req.path === "/api/chat/stream") {
    req.setTimeout(720000);
    res.setTimeout(720000);
  } else if (req.path === "/api/chat/ask") {
    req.setTimeout(300000);
    res.setTimeout(300000);
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "sellsia-dashboard-api" });
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

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
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
  await prisma.$disconnect();
  process.exit(0);
});

app.listen(config.port, () => {
  console.log(`Sellsia dashboard API listening on http://localhost:${config.port}`);
  // Démarre le worker de rappels après que le serveur est prêt
  startReminderWorker();
});
