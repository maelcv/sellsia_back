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
import { getProviderForUser, getActiveProviderCode } from "../../ia_models/providers/index.js";
import { orchestrate, orchestrateStream } from "../../ia_models/orchestrator/dispatcher.js";
import { enrichContext, enrichWithPipelineData, loadKnowledgeContext, getSellsyClient } from "../../ia_models/orchestrator/context.js";
import {
  getOrCreateConversation,
  addMessage,
  getConversationHistory,
  getRecentConversations,
  getConversationMessages
} from "../../ia_models/orchestrator/memory.js";
import { getAvailableTools } from "../../ia_models/mcp/tools.js";
import { resolve as resolvePath, join as joinPath } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const router = express.Router();

// ── Multer for file uploads (in-memory, max 10MB, up to 5 files) ──
const ALLOWED_MIMETYPES = new Set([
  "application/pdf",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    // Les deux conditions doivent être vraies : MIME type ET extension (anti-spoofing)
    const mimeOk = ALLOWED_MIMETYPES.has(file.mimetype);
    const extOk = /\.(pdf|csv|xlsx?|docx?|txt)$/i.test(file.originalname);
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

async function getAllowedAgents(userId) {
  // Get active provider code
  const activeProviderCode = await getActiveProviderCode(userId);

  // If Mistral AI is the active provider, try to get mistral-remote agents first
  if (activeProviderCode === "mistral-cloud") {
    const mistralRows = await prisma.$queryRaw`
      SELECT a.id, a.name
      FROM user_agent_access uaa
      JOIN agents a ON a.id = uaa.agent_id
      WHERE uaa.user_id = ${userId}
        AND uaa.status = 'granted'
        AND a.is_active = true
        AND a.agent_type = 'mistral_remote'
    `;

    // If mistral-remote agents found, use them
    if (mistralRows.length > 0) {
      return {
        agentRows: mistralRows,
        allowedIds: new Set(mistralRows.map((r) => r.id)),
        providerCode: activeProviderCode
      };
    }

    // Fallback: If no mistral-remote agents, allow local agents for backward compatibility
    const localRows = await prisma.$queryRaw`
      SELECT a.id, a.name
      FROM user_agent_access uaa
      JOIN agents a ON a.id = uaa.agent_id
      WHERE uaa.user_id = ${userId}
        AND uaa.status = 'granted'
        AND a.is_active = true
        AND (a.agent_type = 'local' OR a.agent_type IS NULL)
    `;

    return {
      agentRows: localRows,
      allowedIds: new Set(localRows.map((r) => r.id)),
      providerCode: activeProviderCode
    };
  }

  // Otherwise, allow all agents (local and remote that don't require specific providers)
  const rows = await prisma.$queryRaw`
    SELECT a.id, a.name
    FROM user_agent_access uaa
    JOIN agents a ON a.id = uaa.agent_id
    WHERE uaa.user_id = ${userId}
      AND uaa.status = 'granted'
      AND a.is_active = true
  `;

  return {
    agentRows: rows,
    allowedIds: new Set(rows.map((r) => r.id)),
    providerCode: activeProviderCode
  };
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

async function buildToolContext(userId, uploadedFiles = [], toolPrefs = {}) {
  const sellsyClient = await getSellsyClient(userId);
  const referenceSitesByTopic = {
    company: ["pappers.fr", "societe.com", "wikipedia.org"],
    location: ["google.com/maps", "wikipedia.org"],
    news: ["wikipedia.org", "societe.com"],
    generic: ["wikipedia.org", "pappers.fr", "societe.com"]
  };

  const selectedReferenceSites = Array.isArray(toolPrefs.referenceSites) && toolPrefs.referenceSites.length > 0
    ? toolPrefs.referenceSites
    : referenceSitesByTopic.generic;

  const context = {
    sellsyClient,
    tavilyApiKey: config.tavilyApiKey || null,
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

router.post("/ask", requireAuth, upload.array("files", 5), async (req, res) => {
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
  const { allowedIds } = await getAllowedAgents(userId);
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
    // Validate that reqConvId actually exists in DB to avoid FK constraint errors
    let validatedConvId = reqConvId;
    if (reqConvId) {
      const exists = await prisma.conversation.findUnique({
        where: { id: reqConvId },
        select: { id: true }
      });
      if (!exists) {
        console.warn(`[Chat/ask] conversationId ${reqConvId} not found in DB, creating new conversation`);
        validatedConvId = null;
      }
    }
    const conversationId = validatedConvId || await getOrCreateConversation(userId, requestedAgentId, pageContext);

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
    const knowledgeContext = await loadKnowledgeContext(message, requestedAgentId || "commercial", userId);

    // 6. Build tool context
    const { toolContext, tools } = await buildToolContext(userId, uploadedFiles, requestedTools || {});

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
      thinkingMode: requestedTools?.thinking || "low"
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

    // 9. MAJ compteurs tokens (fire-and-forget)
    updateTokenUsage(userId, result.tokensInput || 0, result.tokensOutput || 0);

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

router.post("/stream", requireAuth, upload.array("files", 5), async (req, res) => {
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

  const { allowedIds } = await getAllowedAgents(userId);
  if (allowedIds.size === 0) {
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
    // 1. Enrich Sellsy context
    const sellsyData = await enrichContext(userId, pageContext);

    // 2. Conversation management
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
    const conversationId = validatedConversationId || await getOrCreateConversation(userId, requestedAgentId, pageContext);

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

    const userMsgContent = uploadedFiles.length > 0
      ? `${message}\n\n[Fichiers joints: ${uploadedFiles.map((f) => f.originalname).join(", ")}]`
      : message;
    await addMessage(conversationId, { role: "user", content: userMsgContent });
    const historyForLLM = (await getConversationHistory(conversationId, 20)).slice(0, -1);
    const isFirstMessage = historyForLLM.length === 0;

    // 3. Knowledge base
    const knowledgeContext = await loadKnowledgeContext(message, requestedAgentId || "commercial", userId);

    // 3b. Build tool context for agent tool-calling
    const { toolContext, tools } = await buildToolContext(userId, uploadedFiles, requestedTools || {});

    // 4. Enrich pipeline data if directeur might be involved
    if (
      requestedAgentId === "directeur" ||
      (!requestedAgentId && /(pipeline|reporting|direction|kpi|ca |bilan)/.test(message.toLowerCase()))
    ) {
      const pipelineData = await enrichWithPipelineData(userId);
      if (pipelineData && sellsyData.data) {
        sellsyData.data.pipelineAnalysis = pipelineData;
      }
    }

    const startTime = Date.now();

    // Send metadata (including which tool categories are available)
    const toolCategories = {
      webSearch: tools.some((t) => t.name === "web_search"),
      webScrape: tools.some((t) => t.name === "web_scrape"),
      sellsy: tools.some((t) => t.name.startsWith("sellsy_")),
      fileParser: tools.some((t) => t.name.startsWith("parse_"))
    };
    res.write(`data: ${JSON.stringify({ type: "meta", conversationId, requestedTools: requestedTools || {}, toolCategories })}\n\n`);

    let fullContent = "";
    let streamToolsUsed = [];
    let streamSourcesUsed = { web: [], sellsy: [], files: [] };
    let activeAgentId = null;
    const collectedAgentIds = [];

    // ── Setup heartbeat to keep SSE connection alive (every 30s) ──
    let lastHeartbeat = Date.now();
    heartbeatInterval = setInterval(() => {
      if (res.writable) {
        res.write(": keepalive heartbeat\n\n");
        lastHeartbeat = Date.now();
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
      isFirstMessage
    })) {
      if (clientDisconnected) break;

      // Conversation title (first message naming)
      if (event.type === "conversation_title") {
        res.write(`data: ${JSON.stringify({ type: "conversation_title", title: event.title, conversationId })}\n\n`);
        // Update conversation title in DB
        try {
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { title: event.title }
          });
        } catch (e) {
          console.warn("[Chat] Failed to update conversation title:", e.message);
        }
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
        try {
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { agentId: event.agentId }
          });
        } catch {}
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
        res.write(`data: ${JSON.stringify({ type: "ask_user", question: event.question, suggestions: event.suggestions || [], context: event.context || null })}\n\n`);
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
        break;
      }
    }

    // Clean up heartbeat interval
    clearInterval(heartbeatInterval);

    // Normaliser une seule fois et réutiliser
    const normalizedSources = normalizeSourcesUsed(streamSourcesUsed, pageContext, uploadedFiles);
    res.write(`data: ${JSON.stringify({ type: "tools", toolsUsed: streamToolsUsed, sourcesUsed: normalizedSources })}\n\n`);

    // 8. Save the complete message
    const tokensInput = estimateTokens(message) + estimateTokens(JSON.stringify(historyForLLM));
    const tokensOutput = estimateTokens(fullContent);
    // Use the first valid agent ID (commercial, directeur, technicien) — never a joined/composite or sub-agent ID
    const validAgentIds = new Set(["commercial", "directeur", "technicien"]);
    const agentId = collectedAgentIds.find((id) => validAgentIds.has(id)) || activeAgentId || null;

    const messageId = await addMessage(conversationId, {
      role: "assistant",
      content: fullContent,
      agentId,
      tokensInput,
      tokensOutput,
      provider: provider.providerName,
      model: provider.defaultModel,
      sourcesUsed: normalizedSources
    });

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

    // Fire-and-forget: update token counters
    updateTokenUsage(userId, tokensInput, tokensOutput);

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
  } catch (error) {
    // Clean up heartbeat interval even on error
    clearInterval(heartbeatInterval);

    console.error("[Chat Stream] Error:", error);
    if (!clientDisconnected && res.writable) {
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
    }
    if (res.writable) {
      res.end();
    }
  }
});

// ══════════════════════════════════════════════════════
// GET /api/chat/history — Dernières conversations
// ══════════════════════════════════════════════════════

router.get("/history", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const conversations = await getRecentConversations(userId, limit);
  return res.json({ conversations });
});

// ══════════════════════════════════════════════════════
// GET /api/chat/conversation/:id — Messages d'une conversation
// ══════════════════════════════════════════════════════

router.get("/conversation/:id", requireAuth, async (req, res) => {
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

router.put("/conversation/:id/title", requireAuth, async (req, res) => {
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

router.post("/feedback", requireAuth, async (req, res) => {
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

router.get("/download/:fileId", requireAuth, (req, res) => {
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

router.post("/suggestions", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const pageContext = req.body.pageContext || {};

  const provider = await getProviderForUser(userId);
  if (!provider) {
    // Fallback : suggestions statiques
    return res.json({ suggestions: getStaticSuggestions(pageContext.type) });
  }

  try {
    const sellsyData = await enrichContext(userId, pageContext);

    const { SUGGESTIONS_PROMPT } = await import("../../ia_models/prompts/system/defaults.js");
    const { interpolatePrompt } = await import("../../ia_models/prompts/loader.js");

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

export default router;
