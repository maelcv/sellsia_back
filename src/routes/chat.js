/**
 * Chat Routes — Point d'entrée de l'orchestration IA.
 *
 * POST /api/chat/ask         — Demande synchrone (réponse complète)
 * POST /api/chat/stream      — Demande SSE (streaming)
 * GET  /api/chat/history      — Dernières conversations
 * GET  /api/chat/conversation/:id — Messages d'une conversation
 * POST /api/chat/feedback     — Feedback sur un message
 * GET  /api/chat/download/:fileId — Télécharger un rapport PDF
 * POST /api/chat/suggestions  — Suggestions contextuelles
 *
 * Migrated from SQLite (better-sqlite3) to Prisma/PostgreSQL.
 */

import express from "express";
import multer from "multer";
import { z } from "zod";
import { prisma, logAudit, logReasoningStep, linkReasoningStepsToMessage } from "../prisma.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { chatRateLimit } from "../middleware/security.js";
import { decryptSecret } from "../security/secrets.js";
import { getProviderForUser, getActiveProviderCode } from "../ai-providers/index.js";
import { orchestrate, orchestrateStream } from "../orchestrator/dispatcher.js";
import { enrichContext, enrichWithPipelineData, loadKnowledgeContext, getSellsyClient } from "../orchestrator/context.js";
import {
  getOrCreateConversation,
  addMessage,
  getConversationHistory,
  getRecentConversations,
  getConversationMessages
} from "../orchestrator/memory.js";
import { getAvailableTools } from "../tools/mcp/tools.js";
import { platformEmitter } from "../services/automation-events.js";
import { resolve as resolvePath, join as joinPath } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
// V1 — Memory & Classification
import { classifyUploadedFile } from "../services/classification/file-classifier.js";
import { processConversationMemory } from "../services/memory/conversation-memory.js";


const __dirname = fileURLToPath(new URL(".", import.meta.url));
const router = express.Router();

// ── Multer for file uploads (in-memory, max 10MB, up to 5 files) ──
const ALLOWED_MIMETYPES = new Set([
  // Documents textuels
  "application/pdf",
  "text/csv",
  "text/plain",
  "application/json",
  // Excel
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // Word
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  // PowerPoint
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // OpenDocument
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  // Audio
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/webm",
  "audio/aac",
  "audio/x-wav",
]);

const ALLOWED_EXTENSIONS = /\.(pdf|csv|xlsx?|docx?|txt|json|pptx?|odp|odt|ods|jpe?g|png|gif|webp|bmp|mp3|wav|ogg|m4a|webm|aac)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    // Les deux conditions doivent être vraies : MIME type ET extension (anti-spoofing)
    const mimeOk = ALLOWED_MIMETYPES.has(file.mimetype);
    const extOk = ALLOWED_EXTENSIONS.test(file.originalname);
    if (mimeOk && extOk) {
      cb(null, true);
    } else {
      cb(new Error(`Type de fichier non supporté: ${file.mimetype}`));
    }
  }
});

// ── Schemas ──

const chatSchema = z.object({
  message: z.string().min(2).max(4000),
  pageContext: z
    .object({
      type: z.string().max(64).optional(),
      entityId: z.string().max(128).optional(),
      entityName: z.string().max(500).optional(),
      breadcrumbs: z.string().max(1500).optional(),
      title: z.string().max(500).optional(),
      url: z.string().max(4000).optional(),
      pathname: z.string().max(2000).optional(),
      host: z.string().max(200).optional(),
      sellsyUser: z.string().max(200).nullable().optional(),
      sellsyUserEmail: z.string().max(254).nullable().optional()
    })
    .optional()
    .default({}),
  requestedAgentId: z.string().max(64).optional(),
  conversationId: z.string().max(128).optional(),
  // Set to true when the user message was already saved by a prior /stream call
  // (e.g. stream failed and client falls back to /ask) to avoid duplication.
  noSaveUserMessage: z.boolean().optional().default(false),
  tools: z
    .object({
      webSearch: z.boolean().optional(),
      responseSize: z.enum(["short", "medium", "longer"]).optional(),
      hasFile: z.boolean().optional(),
      thinking: z.enum(["low", "high"]).optional(),
      referenceSites: z.array(z.string().min(3).max(200)).max(20).optional()
    })
    .optional()
    .default({})
});

const feedbackSchema = z.object({
  messageId: z.number().int().positive(),
  rating: z.enum(["positive", "negative"]),
  category: z.enum(["incorrect", "incomplete", "format", "tool_not_used", "irrelevant", "other"]).optional(),
  comment: z.string().max(1000).optional()
});

function getPayloadValidationError(parseError) {
  const firstIssue = parseError?.issues?.[0];
  if (!firstIssue) return "Invalid request payload";

  const path = Array.isArray(firstIssue.path) ? firstIssue.path.join(".") : "request";
  return `Invalid request payload (${path}: ${firstIssue.message})`;
}

// ── Helper : récupérer les agents autorisés (filtrés par provider actif) ──

/**
 * getAllowedAgents — Determine which agents a user can chat with.
 *
 * Admin:       Access to agent-admin (global). Bypasses orchestrator, talks directly.
 * Client:      Agents in workspace plan (via allowedInPlans) + workspace-scoped agents
 *              granted access by admin + agents they created themselves.
 * Sub-client:  Agents granted access via WorkspaceAgentAccess (status='granted').
 */
async function getAllowedAgents(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, workspaceId: true }
  });

  if (!user) {
    console.error("[chat] getAllowedAgents — user not found:", userId);
    return { agentRows: [], allowedIds: new Set(), providerCode: null };
  }

  const role = user.role;
  console.log("[chat] getAllowedAgents — userId:", userId, "role:", role, "workspaceId:", user.workspaceId);

  // ── ADMIN ──────────────────────────────────────────────────────
  // Admins get agent-admin + generaliste. The orchestrator routes platform queries
  // to agent-admin and everything else (météo, culture générale…) to generaliste.
  if (role === "admin") {
    // Ensure agent-admin exists (auto-create if missing)
    let adminAgent = await prisma.agent.findUnique({ where: { id: "agent-admin" } });
    if (!adminAgent) {
      console.log("[chat] agent-admin not found, auto-creating...");
      try {
        adminAgent = await prisma.agent.create({
          data: {
            id: "agent-admin",
            name: "Admin",
            description: "Agent administratif pour la gestion plateforme",
            agentType: "local",
            isActive: true,
            workspaceId: null
          }
        });
        await prisma.agentPrompt.create({
          data: {
            agentId: "agent-admin",
            systemPrompt: "Tu es un assistant administratif expert de la plateforme Boatswain. Tu aides à la gestion des workflows, des processus administratifs, et tu peux accéder à l'ensemble des données de la plateforme pour répondre aux questions.",
            version: 1,
            isActive: true
          }
        });
      } catch (e) {
        console.error("[chat] Failed to auto-create agent-admin:", e.message);
      }
    }

    // Also fetch generaliste so the orchestrator can route non-platform queries
    const generalisteAgent = await prisma.agent.findUnique({ where: { id: "generaliste" } });
    const agents = [adminAgent, generalisteAgent].filter(Boolean);
    console.log("[chat] Admin → granting", agents.length, "agents:", agents.map(a => a.id));
    return {
      agentRows: agents,
      allowedIds: new Set(agents.map(a => a.id)),
      providerCode: "admin-direct"
    };
  }

  // ── CLIENT ─────────────────────────────────────────────────────
  // 1. Agents included in workspace plan (via Plan.allowedAgents)
  // 2. Agents scoped to their workspace (created by admin for them)
  // 3. Agents they own (created themselves if plan permits)
  if (role === "client") {
    const workspaceId = user.workspaceId;
    if (!workspaceId) {
      console.warn("[chat] Client has no workspaceId");
      return { agentRows: [], allowedIds: new Set(), providerCode: null };
    }

    // Get workspace with plan and plan's allowed agents
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        planRecord: {
          select: {
            allowedAgents: { where: { isActive: true }, select: { id: true, name: true } }
          }
        }
      }
    });

    const planAgentIds = (workspace?.planRecord?.allowedAgents || []).map(a => a.id);

    // Agents scoped to this workspace + agents owned by user
    const workspaceAgents = await prisma.agent.findMany({
      where: {
        isActive: true,
        OR: [
          { workspaceId },                    // workspace-scoped agents
          { id: { in: planAgentIds } },       // plan's allowed agents
          { ownerId: userId }                 // self-created agents
        ]
      }
    });

    // Also check WorkspaceAgentAccess for admin-enabled agents
    const waa = await prisma.workspaceAgentAccess.findMany({
      where: { workspaceId, status: 'granted' },
      select: { agentId: true }
    });
    const waaIds = new Set(waa.map(a => a.agentId));

    // Merge: workspace agents + admin-enabled global agents
    const enabledGlobalAgents = waaIds.size > 0
      ? await prisma.agent.findMany({
          where: { id: { in: Array.from(waaIds) }, isActive: true }
        })
      : [];

    const allAgents = [...workspaceAgents, ...enabledGlobalAgents];
    const uniqueMap = new Map(allAgents.map(a => [a.id, a]));
    const agents = Array.from(uniqueMap.values());

    console.log("[chat] Client → granting", agents.length, "agents:", agents.map(a => a.id));
    return {
      agentRows: agents,
      allowedIds: new Set(agents.map(a => a.id)),
      providerCode: await getActiveProviderCode(userId)
    };
  }

  // ── SUB-CLIENT ─────────────────────────────────────────────────
  // Only agents granted access via WorkspaceAgentAccess (status='granted')
  if (role === "sub_client") {
    const workspaceId = user.workspaceId;
    if (!workspaceId) {
      console.warn("[chat] Sub-client has no workspaceId");
      return { agentRows: [], allowedIds: new Set(), providerCode: null };
    }

    const waa = await prisma.workspaceAgentAccess.findMany({
      where: { workspaceId, status: 'granted' },
      select: { agentId: true }
    });

    const agentIds = waa.map(a => a.agentId);
    const agents = agentIds.length > 0
      ? await prisma.agent.findMany({
          where: { id: { in: agentIds }, isActive: true }
        })
      : [];

    console.log("[chat] Sub-client → granting", agents.length, "agents:", agents.map(a => a.id));
    return {
      agentRows: agents,
      allowedIds: new Set(agents.map(a => a.id)),
      providerCode: await getActiveProviderCode(userId)
    };
  }

  // Unknown role fallback
  console.warn("[chat] Unknown role:", role);
  return { agentRows: [], allowedIds: new Set(), providerCode: null };
}

// ── Helper : journaliser l'orchestration ──

function mapRoutingMode(mode) {
  if (!mode) return null;
  const m = mode.replace(/-/g, "_");
  if (m === "single_agent" || m === "multi_agent") return m;
  return null;
}

async function logOrchestration(data) {
  try {
    await prisma.orchestrationLog.create({
      data: {
        conversationId: data.conversationId || null,
        userId: data.userId,
        userMessage: data.userMessage.slice(0, 500),
        detectedIntent: data.intent || null,
        routingMode: mapRoutingMode(data.mode),
        agentsCalled: data.agentsCalled ? JSON.stringify(data.agentsCalled) : null,
        contextType: data.contextType || null,
        contextEntityId: data.contextEntityId || null,
        sellsyDataFetched: data.sellsyDataFetched ? true : false,
        tokensTotal: data.tokensTotal || 0,
        responseTimeMs: data.responseTimeMs || 0,
        error: data.error || null
      }
    });
  } catch (err) {
    console.error("[OrchLog] Failed to log:", err.message);
  }
}

// ── Helper : mise à jour compteurs tokens ──

async function updateTokenUsage(userId, tokensInput, tokensOutput) {
  const total = tokensInput + tokensOutput;
  if (total <= 0) return;

  try {
    await prisma.$executeRaw`
      UPDATE client_plans
      SET token_used = token_used + ${total},
          token_sent = token_sent + ${tokensInput},
          token_received = token_received + ${tokensInput},
          token_processed = token_processed + ${total},
          token_returned = token_returned + ${tokensOutput},
          updated_at = NOW()
      WHERE user_id = ${userId}
    `;
  } catch {
    // Pas critique — l'utilisateur n'a peut-être pas de plan
  }
}

function estimateTokens(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

// ── Helper : build tool context for agent tool-calling ──

async function buildToolContext(userId, uploadedFiles = [], toolPrefs = {}, tenantId = null, features = {}, userRole = null, agentId = null) {
  const sellsyClient = await getSellsyClient(userId);

  const resolveWebSearchApiKey = async () => {
    const extractApiKey = (rawEncrypted, source) => {
      if (!rawEncrypted) return null;
      try {
        const parsed = JSON.parse(decryptSecret(rawEncrypted));
        const key = parsed.tavilyApiKey || parsed.tavily_key || parsed.apiKey || parsed.api_key || parsed.token;
        if (key) {
          console.log(`[chat] Using web search API key from ${source}`);
          return key;
        }
      } catch (err) {
        console.warn(`[chat] Failed to decrypt ${source} web integration credentials:`, err.message);
      }
      return null;
    };

    try {
      const userInt = await prisma.$queryRaw`
        SELECT ui.encrypted_credentials
        FROM user_integrations ui
        JOIN integration_types it ON it.id = ui.integration_type_id
        WHERE ui.user_id = ${userId}
          AND (
            LOWER(it.name) LIKE '%tavily%'
            OR LOWER(it.name) LIKE '%web%'
            OR LOWER(it.name) LIKE '%custom api%'
          )
        ORDER BY ui.linked_at DESC
        LIMIT 1
      `;
      const userKey = extractApiKey(userInt[0]?.encrypted_credentials, `user ${userId}`);
      if (userKey) return userKey;

      if (!tenantId) return null;

      const wsInt = await prisma.$queryRaw`
        SELECT wi.encrypted_config
        FROM workspace_integrations wi
        JOIN integration_types it ON it.id = wi.integration_type_id
        WHERE wi.workspace_id = ${tenantId}
          AND wi.is_enabled = true
          AND (
            LOWER(it.name) LIKE '%tavily%'
            OR LOWER(it.name) LIKE '%web%'
            OR LOWER(it.name) LIKE '%custom api%'
          )
        ORDER BY wi.configured_at DESC
        LIMIT 1
      `;
      return extractApiKey(wsInt[0]?.encrypted_config, `workspace ${tenantId}`);
    } catch (err) {
      console.warn("[chat] resolveWebSearchApiKey failed, fallback to env key:", err.message);
      return null;
    }
  };

  const resolvedWebApiKey = await resolveWebSearchApiKey();
  const referenceSitesByTopic = {
    company: ["pappers.fr", "societe.com", "wikipedia.org"],
    location: ["google.com/maps", "wikipedia.org"],
    news: ["wikipedia.org", "societe.com"],
    generic: ["wikipedia.org", "pappers.fr", "societe.com"]
  };

  const selectedReferenceSites = Array.isArray(toolPrefs.referenceSites) && toolPrefs.referenceSites.length > 0
    ? toolPrefs.referenceSites
    : referenceSitesByTopic.generic;

  const isAdmin = userRole === "admin";

  const context = {
    userId,           // Nécessaire pour le tool schedule_reminder, send_email, create_calendar_event
    tenantId,         // Nécessaire pour les tools email + calendar
    features,         // Feature flags du tenant (email_service, calendar, etc.)
    isAdmin,          // Flag admin pour get_platform_stats
    userRole,         // Role pour les checks d'accès tools (vault, automations...)
    agentId,          // ID agent pour schedule_reminder
    sellsyClient,
    tavilyApiKey: resolvedWebApiKey || config.tavilyApiKey || null,
    uploadedFiles: uploadedFiles || [],
    thinkingMode: toolPrefs.thinking || "low",
    priorityDomains: selectedReferenceSites,
    forceWebSearch: Boolean(toolPrefs.webSearch)
  };

  const tools = getAvailableTools(context, {
    includeFileTools: uploadedFiles.length > 0,
    thinkingMode: toolPrefs.thinking || "low"
  });

  return { toolContext: context, tools };
}

function normalizeSourcesUsed(rawSources, pageContext = {}, uploadedFiles = []) {
  const normalized = {
    web: Array.isArray(rawSources?.web) ? rawSources.web : [],
    sellsy: Array.isArray(rawSources?.sellsy) ? rawSources.sellsy : [],
    files: Array.isArray(rawSources?.files) ? rawSources.files : []
  };

  // N'ajouter un placeholder Sellsy que si une entité réelle est identifiée sur la page
  if (normalized.sellsy.length === 0 && pageContext?.entityId) {
    normalized.sellsy.push({
      objectType: pageContext?.type || "page",
      objectId: pageContext.entityId,
      label: pageContext?.entityName || pageContext?.title || "Contexte Sellsy"
    });
  }

  if (normalized.files.length === 0 && uploadedFiles.length > 0) {
    for (const file of uploadedFiles) {
      normalized.files.push({
        filename: file.originalname,
        tool: "uploaded"
      });
    }
  }

  return normalized;
}

// ── Helper : vérifier le quota mensuel de tokens ──

async function checkTokenQuota(userId) {
  const rows = await prisma.$queryRaw`
    SELECT cp.token_used AS "tokenUsed", p.monthly_token_limit AS "tokenLimit"
    FROM client_plans cp
    JOIN plans p ON p.id = cp.plan_id
    WHERE cp.user_id = ${userId}
  `;

  const planInfo = rows[0] || null;

  if (planInfo && planInfo.tokenLimit > 0 && planInfo.tokenUsed >= planInfo.tokenLimit) {
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════
// POST /api/chat/ask — Demande synchrone
// ══════════════════════════════════════════════════════

router.post("/ask", requireAuth, requireWorkspaceContext, chatRateLimit, upload.array("files", 5), async (req, res) => {
  // Parse body — if multipart, fields are in req.body; files in req.files
  let bodyToParse;
  try {
    bodyToParse = req.body.payload ? JSON.parse(req.body.payload) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid request payload (payload: malformed JSON)" });
  }
  const parse = chatSchema.safeParse(bodyToParse);
  if (!parse.success) {
    return res.status(400).json({ error: getPayloadValidationError(parse.error) });
  }

  const { message, pageContext, requestedAgentId, conversationId: reqConvId, tools: requestedTools, noSaveUserMessage } = parse.data;
  const userId = req.user.sub;
  const userRole = req.user.role || "client";
  const uploadedFiles = req.files || [];

  // 1. Vérifier les permissions
  const { allowedIds, isAdmin } = await getAllowedAgents(userId);
  if (allowedIds.size === 0) {
    return res.status(403).json({
      error: "No granted agents. Request access from dashboard catalog first."
    });
  }

  // 2. Vérifier le quota mensuel de tokens
  if (!(await checkTokenQuota(userId))) {
    return res.status(429).json({
      error: "Monthly token quota exceeded. Please upgrade your plan or wait for next billing cycle."
    });
  }

  // 3. Récupérer le provider LLM
  const provider = await getProviderForUser(userId);
  if (!provider) {
    return res.status(422).json({
      error: "No AI provider configured. Please connect an AI service in your dashboard settings."
    });
  }

  try {
    // 3. Enrichir le contexte Sellsy
    const sellsyData = await enrichContext(userId, pageContext);

    // Si Directeur est demande/probable, enrichir avec le pipeline
    if (
      requestedAgentId === "directeur" ||
      (!requestedAgentId && /(pipeline|reporting|direction|kpi|ca |bilan)/.test(message.toLowerCase()))
    ) {
      const pipelineData = await enrichWithPipelineData(userId);
      if (pipelineData && sellsyData.data) {
        sellsyData.data.pipelineAnalysis = pipelineData;
      }
    }

    // 4. Gérer la conversation (historique)
    // Validate that reqConvId exists AND belongs to the current workspace
    let validatedConvId = reqConvId;
    if (reqConvId) {
      const exists = await prisma.conversation.findUnique({
        where: { id: reqConvId },
        select: { id: true, workspaceId: true }
      });
      if (!exists || exists.workspaceId !== req.workspaceId) {
        validatedConvId = null;
      }
    }
    const conversationId = validatedConvId || await getOrCreateConversation(userId, requestedAgentId, pageContext, req.workspaceId);

    // Sauvegarder le message utilisateur (include file info if any)
    const userMsgContent = uploadedFiles.length > 0
      ? `${message}\n\n[Fichiers joints: ${uploadedFiles.map((f) => f.originalname).join(", ")}]`
      : message;
    // Skip saving if the stream route already persisted the user message (fallback scenario)
    if (!noSaveUserMessage) {
      await addMessage(conversationId, { role: "user", content: userMsgContent });
    }

    // Charger l'historique (excluding the current user message, which is always last)
    const conversationHistory = await getConversationHistory(conversationId, 20);
    const historyForLLM = conversationHistory.slice(0, -1);

    // 5. Charger la knowledge base
    const knowledgeContext = await loadKnowledgeContext(message, requestedAgentId || "commercial", userId, 3, req.workspaceId);

    // 6. Build tool context
    const { toolContext, tools } = await buildToolContext(userId, uploadedFiles, requestedTools || {}, req.workspaceId, req.workspacePlan?.permissions || {}, userRole, requestedAgentId);

    // 7. Orchestrer (with tools)
    const result = await orchestrate({
      provider,
      userMessage: message,
      pageContext,
      sellsyData,
      conversationHistory: historyForLLM,
      userRole,
      clientId: userId,
      conversationId,
      allowedAgents: allowedIds,
      requestedAgentId,
      tools,
      toolContext,
      knowledgeContext,
      thinkingMode: requestedTools?.thinking || "low",
      tenantId: req.workspaceId
    });

    // 8. Sauvegarder la réponse
    const normalizedSourcesUsed = normalizeSourcesUsed(result.sourcesUsed, pageContext, uploadedFiles);

    const messageId = await addMessage(conversationId, {
      role: "assistant",
      content: result.answer,
      agentId: result.agentId,
      tokensInput: result.tokensInput || 0,
      tokensOutput: result.tokensOutput || 0,
      provider: result.provider,
      model: result.model,
      sourcesUsed: normalizedSourcesUsed
    });

    // 8. Journaliser (fire-and-forget)
    logAudit(userId, "CHAT_ASK", {
      conversationId,
      agentId: result.agentId,
      mode: result.mode,
      intent: result.classification?.intent
    });

    logOrchestration({
      conversationId,
      userId,
      userMessage: message,
      intent: result.classification?.intent,
      mode: result.mode,
      agentsCalled: result.classification?.agents,
      contextType: pageContext?.type,
      contextEntityId: pageContext?.entityId,
      sellsyDataFetched: sellsyData?.sellsyConnected && sellsyData?.data != null,
      tokensTotal: (result.tokensInput || 0) + (result.tokensOutput || 0),
      responseTimeMs: result.responseTimeMs
    });

    // 9. MAJ compteurs tokens
    updateTokenUsage(userId, result.tokensInput || 0, result.tokensOutput || 0).catch(err =>
      console.error("[chat/ask] Token usage update failed:", err.message)
    );

    // 10. Fire-and-forget: classify uploads + update user profile memory
    if (uploadedFiles.length > 0 && (req.workspaceId || req.user?.role === "admin")) {
      const userForClassifier = { id: userId, email: req.user?.email, name: req.user?.name };
      for (const file of uploadedFiles) {
        classifyUploadedFile({
          file, userId, workspaceId: req.workspaceId || null,
          conversationId, agentId: result.agentId, user: userForClassifier
        }).catch(err => console.warn("[chat/ask] file-classify failed:", err.message));
      }
    }
    processConversationMemory({
      userId,
      conversationId,
      user: { id: userId, email: req.user?.email, name: req.user?.name }
    }).catch(err => console.warn("[chat/ask] memory-update failed:", err.message));

    // 10. Réponse
    const toolCategories = {
      webSearch: tools.some((t) => t.name === "web_search"),
      webScrape: tools.some((t) => t.name === "web_scrape"),
      sellsy: tools.some((t) => t.name.startsWith("sellsy_")),
      fileParser: tools.some((t) => t.name.startsWith("parse_"))
    };

    return res.json({
      conversationId,
      messageId,
      agentId: result.agentId,
      agentName: result.agentName,
      mode: result.mode,
      answer: result.answer,
      classification: result.classification,
      sellsyContext: {
        connected: sellsyData?.sellsyConnected || false,
        type: sellsyData?.contextType || "generic",
        hasData: sellsyData?.data != null
      },
      tokens: {
        input: result.tokensInput || 0,
        output: result.tokensOutput || 0
      },
      toolsUsed: result.toolsUsed || [],
      sourcesUsed: normalizedSourcesUsed,
      toolCategories,
      uploadedFiles: uploadedFiles.map((f) => ({
        name: f.originalname,
        size: f.size,
        type: f.mimetype
      })),
      requestedTools: requestedTools || {},
      responseTimeMs: result.responseTimeMs
    });
  } catch (error) {
    console.error("[Chat] Orchestration error:", error);

    logOrchestration({
      userId,
      userMessage: message,
      contextType: pageContext?.type,
      contextEntityId: pageContext?.entityId,
      error: error.message,
      responseTimeMs: 0
    });

    return res.status(500).json({
      error: "AI processing failed. Please check your AI provider configuration."
    });
  }
});

// ══════════════════════════════════════════════════════
// POST /api/chat/stream — Streaming SSE (with full orchestration)
// ══════════════════════════════════════════════════════

router.post("/stream", requireAuth, requireWorkspaceContext, chatRateLimit, upload.array("files", 5), async (req, res) => {
  let bodyToParse;
  try {
    bodyToParse = req.body.payload ? JSON.parse(req.body.payload) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid request payload (payload: malformed JSON)" });
  }
  const parse = chatSchema.safeParse(bodyToParse);
  if (!parse.success) {
    return res.status(400).json({ error: getPayloadValidationError(parse.error) });
  }

  const { message, pageContext, requestedAgentId, conversationId: reqConversationId, tools: requestedTools } = parse.data;
  const userId = req.user.sub;
  const userRole = req.user.role || "client";
  const uploadedFiles = req.files || [];

  const { allowedIds, isAdmin } = await getAllowedAgents(userId);
  console.log("[chat] allowedIds.size:", allowedIds.size, "isAdmin:", !!isAdmin);
  if (allowedIds.size === 0) {
    console.error("[chat] User has no access to any agents");
    return res.status(403).json({ error: "No granted agents." });
  }

  if (!(await checkTokenQuota(userId))) {
    return res.status(429).json({
      error: "Monthly token quota exceeded. Please upgrade your plan or wait for next billing cycle."
    });
  }

  const provider = await getProviderForUser(userId);
  if (!provider) {
    return res.status(422).json({ error: "No AI provider configured." });
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  // Track client disconnect for aborting processing
  let clientDisconnected = false;
  res.on("close", () => {
    clientDisconnected = true;
  });

  // Declare heartbeat outside try so catch block can clear it
  let heartbeatInterval = null;

  try {
    // 1. Conversation management
    // Validate that reqConversationId actually exists in DB to avoid FK constraint errors
    let validatedConversationId = reqConversationId;
    if (reqConversationId) {
      const exists = await prisma.conversation.findUnique({
        where: { id: reqConversationId },
        select: { id: true }
      });
      if (!exists) {
        console.warn(`[Chat] conversationId ${reqConversationId} not found in DB, creating new conversation`);
        validatedConversationId = null;
      }
    }
    const isNewConversation = !validatedConversationId;
    const conversationId = validatedConversationId || await getOrCreateConversation(userId, requestedAgentId, pageContext, req.workspaceId);

    // Bug fix: persist agent assignment across messages.
    // On follow-up messages the client may not re-send requestedAgentId, so we
    // read it back from the conversation row to avoid re-classifying every time.
    let effectiveRequestedAgentId = requestedAgentId;
    if (validatedConversationId && !effectiveRequestedAgentId) {
      const existingConv = await prisma.conversation.findUnique({
        where: { id: validatedConversationId },
        select: { agentId: true }
      });
      if (existingConv?.agentId) effectiveRequestedAgentId = existingConv.agentId;
    }

    // Emit conversation metadata early so clients can bind to the conversation
    // while context/tool preparation continues in parallel.
    res.write(`data: ${JSON.stringify({
      type: "meta",
      conversationId,
      requestedTools: requestedTools || {},
      toolCategories: null,
      stage: "initializing"
    })}\n\n`);

    // 2. Preload expensive context in parallel
    const knowledgeAgentId = effectiveRequestedAgentId || requestedAgentId || "commercial";
    const shouldEnrichPipeline =
      knowledgeAgentId === "directeur" ||
      (!requestedAgentId && /(pipeline|reporting|direction|kpi|ca |bilan)/.test(message.toLowerCase()));

    const sellsyDataPromise = enrichContext(userId, pageContext);
    const knowledgeContextPromise = loadKnowledgeContext(message, knowledgeAgentId, userId, 3, req.workspaceId);
    const toolBundlePromise = buildToolContext(
      userId,
      uploadedFiles,
      requestedTools || {},
      req.workspaceId,
      req.workspacePlan?.permissions || {},
      userRole,
      effectiveRequestedAgentId || requestedAgentId
    );
    const pipelineDataPromise = shouldEnrichPipeline
      ? enrichWithPipelineData(userId).catch((err) => {
          console.warn("[Chat] Pipeline enrichment failed:", err.message);
          return null;
        })
      : Promise.resolve(null);

    // Pre-classify media files (images/audio) in parallel with context building.
    // This avoids duplicate AI calls: the agent reads _extractedContent from the file
    // instead of calling parse_image/parse_audio (which would re-invoke the vision/audio API).
    const userForClassifier = { id: userId, email: req.user?.email, name: req.user?.name };
    const mediaTypes = ["image/", "audio/"];
    const classifyPromises = uploadedFiles.map((file) => {
      const isMedia = mediaTypes.some((t) => file.mimetype?.startsWith(t));
      if (!isMedia) return Promise.resolve(null);
      return classifyUploadedFile({
        file, userId, workspaceId: req.workspaceId || null,
        conversationId, agentId: effectiveRequestedAgentId || requestedAgentId, user: userForClassifier
      }).catch((err) => {
        console.warn("[chat/stream] media pre-classify failed:", err.message);
        return null;
      });
    });

    const userMsgContent = uploadedFiles.length > 0
      ? `${message}\n\n[Fichiers joints: ${uploadedFiles.map((f) => f.originalname).join(", ")}]`
      : message;
    await addMessage(conversationId, { role: "user", content: userMsgContent });
    const historyForLLM = (await getConversationHistory(conversationId, 20)).slice(0, -1);
    const isFirstMessage = historyForLLM.length === 0;

    const [sellsyData, knowledgeContext, toolBundle, pipelineData, ...classifyResults] = await Promise.all([
      sellsyDataPromise,
      knowledgeContextPromise,
      toolBundlePromise,
      pipelineDataPromise,
      ...classifyPromises
    ]);
    const { toolContext, tools } = toolBundle;

    // Attach pre-classification results to file objects so parse tools can reuse them
    classifyResults.forEach((result, idx) => {
      if (result) {
        uploadedFiles[idx]._vaultPath = result.vaultPath;
        uploadedFiles[idx]._extractedContent = result.extractedText || null;
        uploadedFiles[idx]._classification = result.classification || null;
      }
    });

    // 3. Enrich pipeline data if directeur might be involved
    if (pipelineData && sellsyData?.data) {
      sellsyData.data.pipelineAnalysis = pipelineData;
    }

    const startTime = Date.now();

    // Send metadata (including which tool categories are available)
    const toolCategories = {
      webSearch: tools.some((t) => t.name === "web_search"),
      webScrape: tools.some((t) => t.name === "web_scrape"),
      sellsy: tools.some((t) => t.name.startsWith("sellsy_")),
      fileParser: tools.some((t) => t.name.startsWith("parse_"))
    };
    res.write(`data: ${JSON.stringify({ type: "meta", conversationId, requestedTools: requestedTools || {}, toolCategories, stage: "ready" })}\n\n`);

    let fullContent = "";
    let streamToolsUsed = [];
    let streamSourcesUsed = { web: [], sellsy: [], files: [] };
    let activeAgentId = null;
    const collectedAgentIds = [];
    let pendingAskUserQuestion = "";
    let pendingAskUserSuggestions = [];
    let streamRealTokensInput = 0;
    let streamRealTokensOutput = 0;

    // ── Setup heartbeat to keep SSE connection alive (every 30s) ──
    heartbeatInterval = setInterval(() => {
      if (res.writable) {
        res.write(": keepalive heartbeat\n\n");
      }
    }, 30000);

    // ── Use orchestrateStream for all modes ──
    for await (const event of orchestrateStream({
      provider,
      userMessage: message,
      pageContext,
      sellsyData,
      conversationHistory: historyForLLM,
      userRole,
      clientId: userId,
      conversationId,
      allowedAgents: allowedIds,
      requestedAgentId: effectiveRequestedAgentId,
      tools,
      toolContext,
      thinkingMode: requestedTools?.thinking || "low",
      knowledgeContext,
      isFirstMessage,
      tenantId: req.workspaceId
    })) {
      if (clientDisconnected) break;

      // Conversation title (first message naming)
      if (event.type === "conversation_title") {
        res.write(`data: ${JSON.stringify({ type: "conversation_title", title: event.title, conversationId })}\n\n`);
        // Update conversation title in DB
        prisma.conversation.update({
          where: { id: conversationId },
          data: { title: event.title }
        }).catch((e) => {
          console.warn("[Chat] Failed to update conversation title:", e.message);
        });
        continue;
      }

      // Agent thinking (before plan)
      if (event.type === "agent_thinking") {
        res.write(`data: ${JSON.stringify({ type: "agent_thinking", agentId: event.agentId, content: event.content })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "agent_thinking",
          agentId: event.agentId,
          data: { content: event.content }
        });
        continue;
      }

      // Agent plan
      if (event.type === "agent_plan") {
        res.write(`data: ${JSON.stringify({ type: "agent_plan", agentId: event.agentId, plan: event.plan })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "agent_plan",
          agentId: event.agentId,
          data: { plan: event.plan }
        });
        continue;
      }

      // Agent pre-response thinking
      if (event.type === "agent_pre_response_thinking") {
        res.write(`data: ${JSON.stringify({ type: "agent_pre_response_thinking", agentId: event.agentId, content: event.content })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "agent_pre_response_thinking",
          agentId: event.agentId,
          data: { content: event.content }
        });
        continue;
      }

      // Orchestrator thinking (shown at top of widget)
      if (event.type === "orchestrator_thinking") {
        res.write(`data: ${JSON.stringify({ type: "orchestrator_thinking", content: event.content })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "classification",
          data: { orchestratorThinking: event.content }
        });
        continue;
      }

      // Agent selected (simple mode)
      if (event.type === "agent_selected") {
        activeAgentId = event.agentId;
        if (!collectedAgentIds.includes(event.agentId)) collectedAgentIds.push(event.agentId);
        // Persist agent assignment on the conversation so future messages skip re-classification
        prisma.conversation.update({
          where: { id: conversationId },
          data: { agentId: event.agentId }
        }).catch(() => {});
        logReasoningStep({
          conversationId,
          stepType: "delegation",
          agentId: event.agentId,
          data: { mode: "single-agent", thinkingMode: requestedTools?.thinking || "low" }
        });
        continue;
      }

      // Sub-agent lifecycle
      if (event.type === "sub_agent_start") {
        // Don't overwrite activeAgentId with sub-agent IDs (e.g. "sellsy-0") — keep the real agent ID
        // Don't push sub-agent IDs to collectedAgentIds — they don't exist in the agents table
        res.write(`data: ${JSON.stringify({ type: "sub_agent_start", agentId: event.agentId, agentName: event.agentName, task: event.task || null })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "sub_agent_start",
          agentId: event.agentId,
          data: {
            task: event.task || null,
            mode: "high-mode",
            thinkingMode: requestedTools?.thinking || "high",
            agentName: event.agentName || null,
            subAgentType: event.subAgentType || null
          }
        });
        continue;
      }

      if (event.type === "sub_agent_thinking") {
        res.write(`data: ${JSON.stringify({ type: "sub_agent_thinking", agentId: event.agentId, content: event.content })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "sub_agent_thinking",
          agentId: event.agentId,
          data: {
            content: event.content,
            agentName: event.agentName || null,
            subAgentType: event.subAgentType || null
          }
        });
        continue;
      }

      if (event.type === "sub_agent_tool_call") {
        // Send as "sub_agent_tool_call" so the widget routes it to the accordion (not main bubble)
        res.write(`data: ${JSON.stringify({ type: "sub_agent_tool_call", agentId: event.agentId, agentName: event.agentName || null, toolName: event.toolName, toolArgs: event.toolArgs, iteration: event.iteration, forced: event.forced })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "tool_call",
          agentId: event.agentId,
          data: {
            toolName: event.toolName,
            toolArgs: event.toolArgs,
            iteration: event.iteration,
            forced: Boolean(event.forced),
            agentName: event.agentName || null,
            subAgentType: event.subAgentType || null
          }
        });
        continue;
      }

      if (event.type === "sub_agent_tool_result") {
        // Send as "sub_agent_tool_result" so the widget routes it to the accordion (not main bubble)
        res.write(`data: ${JSON.stringify({ type: "sub_agent_tool_result", agentId: event.agentId, agentName: event.agentName || null, toolName: event.toolName, success: event.success, error: event.error, iteration: event.iteration, forced: event.forced })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "tool_result",
          agentId: event.agentId,
          data: {
            toolName: event.toolName,
            success: event.success,
            error: event.error,
            resultPreview: event.resultPreview || null,
            iteration: event.iteration,
            forced: Boolean(event.forced),
            agentName: event.agentName || null,
            subAgentType: event.subAgentType || null
          }
        });
        continue;
      }

      if (event.type === "sub_agent_end") {
        res.write(`data: ${JSON.stringify({ type: "sub_agent_end", agentId: event.agentId, agentName: event.agentName, success: event.success, error: event.error || null })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "sub_agent_end",
          agentId: event.agentId,
          data: {
            success: event.success,
            error: event.error || null,
            contentLength: event.contentLength || null,
            toolsUsed: event.toolsUsed || [],
            agentName: event.agentName || null,
            subAgentType: event.subAgentType || null
          }
        });
        continue;
      }

      // Interaction events (ask_user, navigate) — forwarded to frontend
      if (event.type === "ask_user") {
        const suggestions = Array.isArray(event.suggestions)
          ? event.suggestions.map((s) => String(s).trim()).filter(Boolean)
          : typeof event.suggestions === "string"
            ? event.suggestions
                .split(/\n|,|;/)
                .map((s) => s.trim())
                .filter(Boolean)
            : [];

        pendingAskUserQuestion = String(event.question || "").trim();
        pendingAskUserSuggestions = suggestions;

        res.write(`data: ${JSON.stringify({ type: "ask_user", question: event.question, suggestions, context: event.context || null })}\n\n`);
        continue;
      }

      if (event.type === "navigate") {
        res.write(`data: ${JSON.stringify({ type: "navigate", entity_type: event.entity_type, entity_id: event.entity_id, new_tab: Boolean(event.new_tab) })}\n\n`);
        continue;
      }

      // Tool call/result events (from simple single-agent mode)
      if (event.type === "tool_call") {
        res.write(`data: ${JSON.stringify({ type: "tool_call", toolName: event.toolName, toolArgs: event.toolArgs, iteration: event.iteration })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "tool_call",
          agentId: activeAgentId,
          data: { toolName: event.toolName, toolArgs: event.toolArgs, iteration: event.iteration }
        });
        continue;
      }
      if (event.type === "tool_result") {
        res.write(`data: ${JSON.stringify({ type: "tool_result", toolName: event.toolName, success: event.success, error: event.error, iteration: event.iteration })}\n\n`);
        logReasoningStep({
          conversationId,
          stepType: "tool_result",
          agentId: activeAgentId,
          data: { toolName: event.toolName, success: event.success, error: event.error, resultPreview: event.resultPreview || null, iteration: event.iteration }
        });
        continue;
      }

      if (event.type === "sources") {
        streamToolsUsed = event.toolsUsed || [];
        streamSourcesUsed = event.sourcesUsed || { web: [], sellsy: [], files: [] };
        continue;
      }

      // Content chunks
      // Support both formats:
      // - orchestrator events: { type: "chunk", content: "..." }
      // - provider/agent stream events: { chunk: "...", done: false }
      if (event.type === "chunk" || (typeof event.chunk === "string" && !event.type)) {
        const chunkText = event.type === "chunk" ? (event.content || "") : (event.chunk || "");
        if (chunkText) {
          fullContent += chunkText;
          res.write(`data: ${JSON.stringify({ type: "chunk", content: chunkText })}\n\n`);
        }
        continue;
      }

      // Done
      if (event.done || event.type === "done") {
        streamToolsUsed = event.toolsUsed || streamToolsUsed;
        streamSourcesUsed = event.sourcesUsed || streamSourcesUsed;
        if (event.content && !fullContent) fullContent = event.content;
        // Capture real token counts from provider if available (e.g. Mistral usage)
        if (event.tokensInput) streamRealTokensInput = event.tokensInput;
        if (event.tokensOutput) streamRealTokensOutput = event.tokensOutput;
        break;
      }
    }

    // Normaliser une seule fois et réutiliser
    const normalizedSources = normalizeSourcesUsed(streamSourcesUsed, pageContext, uploadedFiles);
    res.write(`data: ${JSON.stringify({ type: "tools", toolsUsed: streamToolsUsed, sourcesUsed: normalizedSources })}\n\n`);

    // Guarantee a visible assistant response even when provider/tools produced no text.
    if (!String(fullContent || "").trim()) {
      const failedTool = (streamToolsUsed || []).find((t) => t?.success === false);
      if (failedTool?.name?.startsWith("sellsy_")) {
        fullContent = "Je n'ai pas pu recuperer vos donnees Sellsy avec la connexion actuelle. Verifiez votre integration Sellsy (token revoque ou expire), puis reconnectez-la depuis votre profil.";
      } else if (failedTool) {
        fullContent = `Je n'ai pas pu terminer la recuperation des donnees (outil en erreur: ${failedTool.name}). Veuillez verifier vos integrations et reessayer.`;
      } else if (pendingAskUserQuestion) {
        fullContent = pendingAskUserQuestion;
        if (pendingAskUserSuggestions.length > 0) {
          fullContent += "\n\nSuggestions: " + pendingAskUserSuggestions.join(" | ");
        }
      } else {
        fullContent = "Je n'ai pas pu produire une reponse complete cette fois. Veuillez reessayer.";
      }
    }

    // 8. Save the complete message
    // Use real token counts from provider (Mistral/Anthropic usage event) if available, else estimate
    const tokensInput = streamRealTokensInput || (estimateTokens(message) + estimateTokens(JSON.stringify(historyForLLM)));
    const tokensOutput = streamRealTokensOutput || estimateTokens(fullContent);
    // Use the first valid agent ID (commercial, directeur, technicien, generaliste) — never a joined/composite or sub-agent ID
    const validAgentIds = new Set(["commercial", "directeur", "technicien", "generaliste"]);
    const agentId = collectedAgentIds.find((id) => validAgentIds.has(id)) || activeAgentId || null;

    let messageId;
    try {
      messageId = await addMessage(conversationId, {
        role: "assistant",
        content: fullContent,
        agentId,
        tokensInput,
        tokensOutput,
        provider: provider.providerName,
        model: provider.defaultModel,
        sourcesUsed: normalizedSources
      });
    } catch (err) {
      console.error("[chat/stream] addMessage failed:", err.message);
      throw err;
    }

    // Log final response reasoning step (with messageId now available)
    logReasoningStep({
      conversationId,
      messageId,
      stepType: "final_response",
      agentId,
      data: {
        tokensInput,
        tokensOutput,
        toolsUsed: streamToolsUsed,
        sourcesCount: {
          web: streamSourcesUsed.web?.length || 0,
          sellsy: streamSourcesUsed.sellsy?.length || 0,
          files: streamSourcesUsed.files?.length || 0
        },
        contentLength: fullContent.length,
        responseTimeMs: Date.now() - startTime
      }
    });

    // Backfill all unlinked reasoning steps to this message
    linkReasoningStepsToMessage(conversationId, messageId);

    // Update token counters
    updateTokenUsage(userId, tokensInput, tokensOutput).catch(err =>
      console.error("[chat/stream] Token usage update failed:", err.message)
    );

    const inferredMode = collectedAgentIds.length > 1 ? "multi-agent" : "single-agent";

    logOrchestration({
      conversationId,
      userId,
      userMessage: message,
      intent: null,
      mode: inferredMode,
      agentsCalled: collectedAgentIds,
      contextType: pageContext?.type,
      contextEntityId: pageContext?.entityId,
      sellsyDataFetched: sellsyData?.sellsyConnected && sellsyData?.data != null,
      tokensTotal: tokensInput + tokensOutput,
      responseTimeMs: Date.now() - startTime
    });

    logAudit(userId, "CHAT_STREAM", {
      conversationId,
      agentId,
      mode: inferredMode,
      intent: null
    });

    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({
        type: "done",
        messageId,
        toolsUsed: streamToolsUsed,
        sourcesUsed: normalizedSources,
        uploadedFiles: uploadedFiles.map((f) => ({ name: f.originalname, size: f.size, type: f.mimetype }))
      })}\n\n`);
    }
    res.end();

    // Émettre l'événement plateforme pour les automations
    if (req.workspaceId) {
      platformEmitter.emit("conversation.ended", {
        workspaceId: req.workspaceId,
        userId,
        conversationId,
        agentId: activeAgentId || agentId,
      });
    }

    // ── V1: Fire-and-forget post-stream hooks ─────────────────────
    // These run asynchronously and NEVER block the SSE response.

    // 1. Classify uploaded files → vault note + KnowledgeDocument
    // Media files (images/audio) were already pre-classified synchronously before the agent ran.
    // Skip those to avoid duplicate AI calls and double vault writes.
    if (uploadedFiles.length > 0 && (req.workspaceId || req.user?.role === "admin")) {
      const userForClassifier2 = { id: userId, email: req.user?.email, name: req.user?.name };
      for (const file of uploadedFiles) {
        if (file._vaultPath) continue; // already classified pre-stream
        classifyUploadedFile({
          file,
          userId,
          workspaceId: req.workspaceId || null,
          conversationId,
          agentId: activeAgentId || agentId,
          user: userForClassifier2
        }).catch(err => console.warn("[chat/stream] file-classify failed:", err.message));
      }
    }

    // 2. Update user profile from conversation insights
    processConversationMemory({
      userId,
      conversationId,
      user: { id: userId, email: req.user?.email, name: req.user?.name }
    }).catch(err => console.warn("[chat/stream] memory-update failed:", err.message));
    // ─────────────────────────────────────────────────────────────

  } catch (error) {
    console.error("[Chat Stream] Error:", error);
    if (!clientDisconnected && res.writable) {
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
    }
    if (res.writable) {
      res.end();
    }
  } finally {
    // Always clean up heartbeat to avoid zombie timers leaking memory.
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  }
});

// ══════════════════════════════════════════════════════
// GET /api/chat/history — Dernières conversations
// ══════════════════════════════════════════════════════

router.get("/history", requireAuth, requireWorkspaceContext, async (req, res) => {
  const userId = req.user.sub;
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const conversations = await getRecentConversations(userId, limit);
  return res.json({ conversations });
});

// ══════════════════════════════════════════════════════
// GET /api/chat/conversation/:id — Messages d'une conversation
// ══════════════════════════════════════════════════════

router.get("/conversation/:id", requireAuth, requireWorkspaceContext, async (req, res) => {
  const userId = req.user.sub;
  const messages = await getConversationMessages(req.params.id, userId);

  if (messages === null) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  return res.json({ messages });
});

// ══════════════════════════════════════════════════════
// PUT /api/chat/conversation/:id/title — Renommer manuellement une conversation
// ══════════════════════════════════════════════════════

router.put("/conversation/:id/title", requireAuth, requireWorkspaceContext, async (req, res) => {
  const userId = req.user.sub || req.user.id;
  const { title } = req.body;
  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "Titre invalide" });
  }

  try {
    const conv = await prisma.conversation.findFirst({
      where: { id: req.params.id, userId }
    });
    
    if (!conv) {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    await prisma.conversation.update({
      where: { id: req.params.id },
      data: { title }
    });
    return res.json({ success: true, title });
  } catch (err) {
    console.error(`[Chat] Error updating title for conversation ${req.params.id}:`, err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══════════════════════════════════════════════════════
// POST /api/chat/feedback — Feedback sur un message
// ══════════════════════════════════════════════════════

router.post("/feedback", requireAuth, requireWorkspaceContext, async (req, res) => {
  const parse = feedbackSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid feedback payload" });
  }

  const { messageId, rating, category, comment } = parse.data;
  const userId = req.user.sub;

  // Vérifier que le message existe et appartient à une conversation de l'utilisateur
  const msg = await prisma.message.findFirst({
    where: {
      id: messageId,
      conversation: { userId }
    },
    select: { id: true }
  });

  if (!msg) {
    return res.status(404).json({ error: "Message not found" });
  }

  await prisma.messageFeedback.create({
    data: {
      messageId,
      userId,
      rating,
      category: category || null,
      comment: comment || null
    }
  });

  logAudit(userId, "MESSAGE_FEEDBACK", { messageId, rating, category });
  return res.json({ message: "Feedback recorded" });
});

// ══════════════════════════════════════════════════════
// GET /api/chat/download/:fileId — Télécharger un rapport PDF
// ══════════════════════════════════════════════════════

router.get("/download/:fileId", requireAuth, requireWorkspaceContext, (req, res) => {
  const fileId = req.params.fileId;

  // Validate UUID format to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    return res.status(400).json({ error: "Invalid file ID" });
  }

  const reportsDir = resolvePath(__dirname, "../../data/reports");
  const filename = `rapport-${fileId.slice(0, 8)}.pdf`;
  const filePath = joinPath(reportsDir, filename);

  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "Report not found" });
  }

  res.download(filePath, filename);
});

// ══════════════════════════════════════════════════════
// POST /api/chat/suggestions — Suggestions contextuelles
// ══════════════════════════════════════════════════════

router.post("/suggestions", requireAuth, requireWorkspaceContext, async (req, res) => {
  const userId = req.user.sub;
  const pageContext = req.body.pageContext || {};

  const provider = await getProviderForUser(userId);
  if (!provider) {
    // Fallback : suggestions statiques
    return res.json({ suggestions: getStaticSuggestions(pageContext.type) });
  }

  try {
    const sellsyData = await enrichContext(userId, pageContext);

    const { SUGGESTIONS_PROMPT } = await import("../prompts/system/defaults.js");
    const { interpolatePrompt } = await import("../prompts/loader.js");

    const prompt = interpolatePrompt(SUGGESTIONS_PROMPT, {
      context: JSON.stringify({
        pageType: sellsyData.contextType,
        hasData: sellsyData.data != null,
        entitySummary: sellsyData.data
          ? JSON.stringify(sellsyData.data).slice(0, 500)
          : "Aucune donnée"
      })
    });

    const result = await provider.classify(prompt, "Génère les suggestions.");

    if (result.suggestions && Array.isArray(result.suggestions)) {
      return res.json({ suggestions: result.suggestions.slice(0, 5) });
    }

    return res.json({ suggestions: getStaticSuggestions(pageContext.type) });
  } catch {
    return res.json({ suggestions: getStaticSuggestions(pageContext.type) });
  }
});

function getStaticSuggestions(contextType) {
  const base = [
    { label: "Résumer cette page", intent: "commercial" },
    { label: "Actions recommandées", intent: "commercial" }
  ];

  switch (contextType) {
    case "company":
      return [
        { label: "Brief du compte", intent: "commercial" },
        { label: "Préparer un RDV", intent: "commercial" },
        { label: "Historique client", intent: "commercial" },
        { label: "Analyser le potentiel", intent: "directeur" }
      ];
    case "opportunity":
      return [
        { label: "Analyser cette opportunité", intent: "commercial" },
        { label: "Stratégie de closing", intent: "commercial" },
        { label: "Identifier les risques", intent: "directeur" },
        { label: "Automatiser le suivi", intent: "technicien" }
      ];
    case "quote":
      return [
        { label: "Résumer le devis", intent: "commercial" },
        { label: "Préparer la relance", intent: "commercial" },
        { label: "Taux de conversion", intent: "directeur" },
        { label: "Automatiser les relances", intent: "technicien" }
      ];
    case "contact":
      return [
        { label: "Fiche contact", intent: "commercial" },
        { label: "Préparer un appel", intent: "commercial" },
        { label: "Historique interactions", intent: "commercial" },
        { label: "Scoring du contact", intent: "directeur" }
      ];
    default:
      return [
        ...base,
        { label: "Analyse du pipeline", intent: "directeur" },
        { label: "Configuration Sellsy", intent: "technicien" }
      ];
  }
}

// ── Approval workflow for CRM/Task write actions ──

/**
 * POST /api/chat/approve
 * User approves or rejects a pending CRM/Task action
 * Pending actions are stored in-memory per session
 */
const pendingActions = new Map(); // sessionId -> action

const approveSchema = z.object({
  conversationId: z.string().min(1),
  actionId: z.string().min(1),
  approved: z.boolean(),
  confirmPassword: z.string().optional() // For sensitive operations
});

router.post("/approve", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const { conversationId, actionId, approved } = approveSchema.parse(req.body);

    // Retrieve pending action
    const sessionKey = `${req.user.sub}:${conversationId}`;
    const pendingAction = pendingActions.get(sessionKey);

    if (!pendingAction || pendingAction.id !== actionId) {
      return res.status(404).json({ error: "Pending action not found or expired" });
    }

    if (!approved) {
      // User rejected the action
      pendingActions.delete(sessionKey);
      await addMessage(conversationId, "assistant", "Action annulée par l'utilisateur.", {});
      return res.json({ success: true, message: "Action rejected" });
    }

    // User approved — execute the action
    try {
      let result;

      if (pendingAction.type === "create_crm") {
        // Execute CRM creation via Sellsy API or DB
        result = await executeCRMAction(pendingAction.action, req.workspaceId);
      } else if (pendingAction.type === "create_task") {
        // Create calendar event or reminder
        result = await createTaskFromApproval(pendingAction.action, req.user.sub);
      } else {
        return res.status(400).json({ error: `Unknown action type: ${pendingAction.type}` });
      }

      // Clean up
      pendingActions.delete(sessionKey);

      // Save action result to conversation
      const resultMessage = `Action exécutée avec succès. ${result.message}`;
      await addMessage(conversationId, "assistant", resultMessage, { actionResult: result });

      return res.json({ success: true, result });
    } catch (execErr) {
      console.error("[Approval] Execution error:", execErr);
      pendingActions.delete(sessionKey);
      return res.status(500).json({ error: `Execution failed: ${execErr.message}` });
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", issues: err.errors });
    }
    console.error("[Approval] Error:", err);
    res.status(500).json({ error: "Approval processing failed" });
  }
});

/**
 * Helper: Execute CRM action (create/update/delete)
 */
async function executeCRMAction(action, workspaceId) {
  // This would integrate with your Sellsy client or CRM provider
  // For now, return a placeholder
  return {
    success: true,
    message: `${action.type} ${action.object} completed`,
    data: action
  };
}

/**
 * Helper: Create task/event/reminder from approval
 */
async function createTaskFromApproval(action, userId) {
  const { title, date, time, isAllDay, description } = action;

  if (action.type === "create_event") {
    const event = await prisma.calendarEvent.create({
      data: {
        userId,
        title,
        startDate: new Date(date),
        endDate: new Date(date),
        isAllDay: isAllDay ?? false,
        description: description || null
      }
    });
    return { success: true, message: "Event created", eventId: event.id };
  }

  if (action.type === "create_reminder") {
    const reminder = await prisma.reminder.create({
      data: {
        userId,
        title,
        reminderDate: new Date(`${date}T${time || "09:00"}`),
        status: "pending",
      }
    });
    return { success: true, message: "Reminder created", reminderId: reminder.id };
  }

  throw new Error(`Unknown task type: ${action.type}`);
}

export { pendingActions };
export default router;
