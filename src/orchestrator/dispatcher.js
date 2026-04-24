/**
 * Dispatcher / Orchestrateur — Le cerveau central de Boatswain.
 *
 * Recoit une demande utilisateur et :
 * 1. Identifie l'intention via LLM (ou agent explicitement demande)
 * 2. Route vers le bon agent (Directeur, Commercial, Technicien, Generaliste)
 * 3. L'agent gere en interne ses sous-agents (File → Sellsy → Web)
 * 4. Journalise l'orchestration
 */

import { SYSTEM_PROMPTS } from "../prompts/system/defaults.js";
import { loadPrompt, interpolatePrompt } from "../prompts/loader.js";
import { logger } from "../lib/logger.js";
import { DirecteurAgent } from "../agents/directeur.js";
import { CommercialAgent } from "../agents/commercial.js";
import { TechnicienAgent } from "../agents/technicien.js";
import { GeneralisteAgent } from "../agents/generaliste.js";
import { BaseAgent, detectUserLanguage } from "../agents/base-agent.js";
import { TemplateAgent } from "../agents/template-agent.js";
import { prisma, logProviderError } from "../prisma.js";
import { selectSkill } from "../skills/router.js";
import { formatSkillForInjection } from "../skills/catalog.js";

const GENERALIST_AGENT_ID = "generaliste";
const SPECIALIST_AGENT_IDS = new Set(["directeur", "commercial", "technicien"]);
const ROUTABLE_AGENT_IDS = new Set([...SPECIALIST_AGENT_IDS, GENERALIST_AGENT_ID]);

const GENERALIST_TOOL_ALLOWLIST = new Set([
  "ask_user",
  "web_search",
  "web_scrape",
  "parse_pdf",
  "parse_csv",
  "parse_excel",
  "parse_word",
]);

const AGENT_CLASSES = {
  "directeur": DirecteurAgent,
  "commercial": CommercialAgent,
  "technicien": TechnicienAgent,
  [GENERALIST_AGENT_ID]: GeneralisteAgent
};

function getRoutingCandidates(allowedAgents) {
  const candidates = new Set(allowedAgents || []);
  candidates.add(GENERALIST_AGENT_ID);
  return candidates;
}

function pickPreferredSpecialist(allowedAgents) {
  if (!allowedAgents || allowedAgents.size === 0) return "commercial";
  if (allowedAgents.has("commercial")) return "commercial";
  if (allowedAgents.has("directeur")) return "directeur";
  if (allowedAgents.has("technicien")) return "technicien";
  return [...allowedAgents][0];
}

function normalizeClassification(classification, allowedAgents, userMessage = "") {
  const rawAgent = String(classification?.agent || "").trim().toLowerCase();
  const rawIntent = String(classification?.intent || "").trim().toLowerCase();
  const normalizedMessage = String(userMessage || "").toLowerCase();
  const parsedConfidence = Number(classification?.confidence);
  const confidence = Number.isFinite(parsedConfidence)
    ? Math.min(Math.max(parsedConfidence, 0), 1)
    : 0.5;

  const outOfScopeIntent = new Set([
    "general",
    "generaliste",
    "hors_sujet",
    "hors-sujet",
    "out_of_scope",
    "out-of-scope"
  ]);

  const isOutOfScope = outOfScopeIntent.has(rawIntent) || outOfScopeIntent.has(rawAgent);
  const hasUnknownAgent = rawAgent !== "" && !ROUTABLE_AGENT_IDS.has(rawAgent);
  const lowConfidence = confidence < 0.45;
  const hasSpecialistHint = /(pipeline|kpi|reporting|forecast|ca\b|prospect|client|relance|devis|opportunit[eé]|vente|closing|contact|api|workflow|automatisation|webhook|integration|parametrage|sellsy)/.test(normalizedMessage);

  if (isOutOfScope || hasUnknownAgent || (lowConfidence && !hasSpecialistHint)) {
    return {
      intent: GENERALIST_AGENT_ID,
      agent: GENERALIST_AGENT_ID,
      confidence: Math.max(confidence, 0.45),
      reasoning: classification?.reasoning || "Demande hors specialite metier: fallback vers l'agent generaliste."
    };
  }

  if (ROUTABLE_AGENT_IDS.has(rawAgent)) {
    return {
      intent: rawIntent || rawAgent,
      agent: rawAgent,
      confidence,
      reasoning: classification?.reasoning || ""
    };
  }

  const fallbackAgent = pickPreferredSpecialist(allowedAgents);
  return {
    intent: fallbackAgent,
    agent: fallbackAgent,
    confidence: 0.5,
    reasoning: classification?.reasoning || `Classification incertaine pour: ${String(userMessage || "").slice(0, 120)}`
  };
}

function selectToolsForAgent(agentId, tools = []) {
  if (!Array.isArray(tools)) return [];
  if (agentId !== GENERALIST_AGENT_ID) return tools;
  return tools.filter((tool) => GENERALIST_TOOL_ALLOWLIST.has(tool?.name));
}

function buildToolContextForAgent(agentId, toolContext = null) {
  if (agentId !== GENERALIST_AGENT_ID) return toolContext;
  const base = toolContext ? { ...toolContext } : {};
  return {
    ...base,
    sellsyClient: null,
    forceWebSearch: true
  };
}

/**
 * Wrapper agent for Mistral AI Studio remote agents
 */
class RemoteAgent {
  constructor({ provider, mistralAgentId, agentName }) {
    this.provider = provider;
    this.mistralAgentId = mistralAgentId;
    this.agentName = agentName;
    this.providerName = "mistral-remote";
  }

  analyzeMistralError(error, httpStatus = null) {
    const message = String(error?.message || "").toLowerCase();

    if (httpStatus === 402 || (httpStatus === 429 && (message.includes("insufficient") || message.includes("credit")))) {
      return { type: "insufficient_credits", message: error?.message || "Insufficient Mistral credits" };
    }
    if (httpStatus === 429) {
      return { type: "rate_limited", message: error?.message || "Mistral rate limit exceeded" };
    }
    if (httpStatus === 401 || message.includes("unauthorized") || message.includes("invalid api")) {
      return { type: "auth_failed", message: error?.message || "Mistral API key invalid" };
    }
    if (httpStatus >= 500) {
      return { type: "api_error", message: error?.message || `Mistral API error ${httpStatus}` };
    }
    if (message.includes("fetch") || message.includes("network") || message.includes("econnrefused")) {
      return { type: "network_error", message: error?.message || "Network error connecting to Mistral" };
    }
    return { type: "unknown", message: error?.message || "Unknown Mistral error" };
  }

  async execute({ userMessage, conversationHistory, clientId, conversationId }) {
    const messages = conversationHistory
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .map((msg) => ({ role: msg.role, content: msg.content }));
    messages.push({ role: "user", content: userMessage });

    try {
      const result = await this.provider.chatWithAgent({
        agentId: this.mistralAgentId,
        messages,
        temperature: 0.7,
        maxTokens: 2048
      });

      return {
        answer: result.content,
        tokensInput: result.tokensInput || 0,
        tokensOutput: result.tokensOutput || 0,
        agentId: this.mistralAgentId,
        agentName: this.agentName,
        provider: this.providerName,
        classification: { intent: "delegated-to-mistral", agent: this.mistralAgentId },
        mode: "single-agent"
      };
    } catch (error) {
      console.error("[RemoteAgent] Mistral API error:", error);
      const errorAnalysis = this.analyzeMistralError(error);
      const httpStatus = error?.response?.status || error?.status || null;

      try {
        await logProviderError({
          providerCode: "mistral-cloud",
          errorType: errorAnalysis.type,
          httpStatus,
          errorMessage: errorAnalysis.message,
          conversationId: conversationId || null,
          agentId: this.mistralAgentId,
          userId: clientId,
          rawError: { message: error?.message, status: httpStatus }
        });
      } catch (logErr) {
        console.warn("[RemoteAgent] Failed to log provider error:", logErr.message);
      }

      throw new Error(`Mistral AI Studio agent error: ${errorAnalysis.message}`);
    }
  }

  async *executeStream({ userMessage, conversationHistory, clientId, conversationId }) {
    const messages = conversationHistory
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .map((msg) => ({ role: msg.role, content: msg.content }));
    messages.push({ role: "user", content: userMessage });

    try {
      for await (const chunk of this.provider.streamWithAgent({
        agentId: this.mistralAgentId,
        messages,
        temperature: 0.7,
        maxTokens: 2048
      })) {
        if (chunk.done) {
          yield { type: "done", content: "", agentId: this.mistralAgentId, toolsUsed: [], sourcesUsed: { web: [], sellsy: [], files: [] } };
          return;
        }
        yield { type: "chunk", content: chunk.chunk };
      }
    } catch (error) {
      console.error("[RemoteAgent] Mistral stream error:", error);
      const errorAnalysis = this.analyzeMistralError(error);
      const httpStatus = error?.response?.status || error?.status || null;

      try {
        await logProviderError({
          providerCode: "mistral-cloud",
          errorType: errorAnalysis.type,
          httpStatus,
          errorMessage: errorAnalysis.message,
          conversationId: conversationId || null,
          agentId: this.mistralAgentId,
          userId: clientId,
          rawError: { message: error?.message, status: httpStatus }
        });
      } catch (logErr) {
        console.warn("[RemoteAgent] Failed to log provider error:", logErr.message);
      }

      yield { type: "chunk", content: `Erreur Mistral: ${errorAnalysis.message}` };
      yield { type: "done", content: `Erreur Mistral: ${errorAnalysis.message}`, toolsUsed: [], sourcesUsed: { web: [], sellsy: [], files: [] } };
    }
  }
}


/**
 * Classifie l'intention de l'utilisateur via le LLM.
 * Retourne l'agent a utiliser : commercial, directeur, technicien ou generaliste.
 */
export async function classifyIntent(provider, userMessage, pageContext, userRole, allowedAgents = null) {
  let availableAgentsInfo = "";
  if (allowedAgents && allowedAgents.size > 0) {
    const agentDescriptions = {
      "commercial": "Commercial — aide a la vente, briefs comptes, relances, opportunites, contacts, devis",
      "directeur": "Directeur — reporting, analyse pipeline, KPIs, previsions, pilotage direction",
      "technicien": "Technicien — configuration Sellsy, API, automatisation, integration technique",
      "generaliste": "Generaliste — fallback hors specialite, recherche web, synthese multi-sujets"
    };
    const allowed = [...allowedAgents]
      .filter((id) => agentDescriptions[id])
      .map((id) => `- ${id}: ${agentDescriptions[id]}`)
      .join("\n");
    if (allowed) {
      availableAgentsInfo = `\n\nAGENTS DISPONIBLES pour cet utilisateur :\n${allowed}`;
    }
  }

  const orchestratorPrompt = interpolatePrompt(SYSTEM_PROMPTS["orchestrator"], {
    pageContext: JSON.stringify(pageContext || {}),
    userRole: userRole || "client"
  }) + availableAgentsInfo;

  try {
    const result = await provider.classify(orchestratorPrompt, userMessage);

    if (result.parseError) {
      return fallbackClassification(userMessage, allowedAgents);
    }

    return normalizeClassification({
      intent: result.intent || "commercial",
      agent: result.agent || "commercial",
      confidence: result.confidence || 0.5,
      reasoning: result.reasoning || ""
    }, allowedAgents, userMessage);
  } catch (error) {
    console.error("[Dispatcher] Classification error:", error.message);
    return fallbackClassification(userMessage, allowedAgents);
  }
}

/**
 * Classification de fallback (regex) si le LLM echoue.
 */
function fallbackClassification(message, allowedAgents = null) {
  const m = message.toLowerCase();
  const has = (id) => !allowedAgents || allowedAgents.has(id);

  if (has("directeur") && /(pipeline|reporting|direction|kpi|prevision|ca |chiffre|bilan|performance|objectif|forecast|tableau de bord)/.test(m)) {
    return {
      intent: "directeur",
      agent: "directeur",
      confidence: 0.6,
      reasoning: "Fallback regex: mots-cles management detectes"
    };
  }

  if (has("technicien") && /(int[eé]gration|api|workflow|automatisation|param[eé]trage|technique|webhook|zapier|make|configuration|champ.+personnalis)/.test(m)) {
    return {
      intent: "technicien",
      agent: "technicien",
      confidence: 0.6,
      reasoning: "Fallback regex: mots-cles techniques detectes"
    };
  }

  if (has("commercial") && /(prospect|client|relance|devis|opportunit[eé]|vente|closing|rdv|contact|compte)/.test(m)) {
    return {
      intent: "commercial",
      agent: "commercial",
      confidence: 0.6,
      reasoning: "Fallback regex: mots-cles commerciaux detectes"
    };
  }

  if (has(GENERALIST_AGENT_ID)) {
    return {
      intent: GENERALIST_AGENT_ID,
      agent: GENERALIST_AGENT_ID,
      confidence: 0.55,
      reasoning: "Fallback regex: demande hors scope CRM, routage vers generaliste"
    };
  }

  const defaultAgent = pickPreferredSpecialist(allowedAgents);
  return {
    intent: defaultAgent,
    agent: defaultAgent,
    confidence: 0.5,
    reasoning: "Fallback regex: defaut vers " + defaultAgent
  };
}

/**
 * Safely parse a JSON string. Returns fallback on error.
 */
function safeJson(str, fallback = []) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function mapProviderCodeToFamily(providerCode) {
  const code = String(providerCode || "").trim();
  if (!code) return "";
  if (code === "openai-cloud" || code === "openrouter-cloud" || code === "lmstudio-local") return "openai";
  if (code === "anthropic-cloud") return "anthropic";
  if (code === "mistral-cloud") return "mistral";
  if (code === "ollama-local") return "ollama";
  return "";
}

function buildProviderOverrides(providerCode) {
  const code = String(providerCode || "").trim();
  if (code === "openrouter-cloud") {
    return { baseUrl: "https://openrouter.ai/api/v1" };
  }
  if (code === "lmstudio-local") {
    return { baseUrl: "http://localhost:1234/v1" };
  }
  return {};
}

function applyAgentProviderOverrides(baseProvider, { defaultProviderCode, defaultModel }) {
  if (!baseProvider) return baseProvider;
  if (!defaultProviderCode && !defaultModel) return baseProvider;

  const currentFamily = String(baseProvider.providerName || "").trim();
  const targetFamily = mapProviderCodeToFamily(defaultProviderCode) || currentFamily;

  if (targetFamily && currentFamily && targetFamily !== currentFamily) {
    console.warn(
      `[Dispatcher] Agent provider override skipped: requested family '${targetFamily}' ` +
      `but active provider family is '${currentFamily}'`
    );
    return baseProvider;
  }

  try {
    const ProviderClass = baseProvider.constructor;
    const overrides = {
      ...(baseProvider.config || {}),
      ...(defaultModel ? { defaultModel } : {}),
      ...buildProviderOverrides(defaultProviderCode),
    };
    return new ProviderClass(overrides);
  } catch (err) {
    console.warn("[Dispatcher] Failed to apply agent provider/model override:", err.message);
    return baseProvider;
  }
}

/**
 * Instancie un agent specialise (local ou remote Mistral).
 * Charge la configuration de l'agent depuis la DB pour les agents workspace-scoped.
 *
 * @param {string} agentId
 * @param {Object} provider
 * @param {number} clientId
 * @param {string|null} workspaceId - Current workspace (for isolation enforcement)
 */
async function createAgent(agentId, provider, clientId, workspaceId = null) {
  // 1) Fetch full agent config from DB
  try {
    const agentRow = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        name: true,
        agentType: true,
        mistralAgentId: true,
        workspaceId: true,
        templateId: true,
        allowedSubAgents: true,
        allowedTools: true,
        defaultProviderCode: true,
        defaultModel: true,
        agentPrompts: { where: { isActive: true }, take: 1, select: { systemPrompt: true } }
      }
    });

    if (agentRow) {
      // Security: workspace-scoped agents can only be used from their own workspace
      if (agentRow.workspaceId && workspaceId && agentRow.workspaceId !== workspaceId) {
        console.warn(
          `[Dispatcher] SECURITY: agent ${agentId} belongs to workspace ${agentRow.workspaceId}, ` +
          `but called from workspace ${workspaceId}. Blocking.`
        );
        return null;
      }

      if (agentRow.agentType === "mistral_remote" && agentRow.mistralAgentId) {
        const providerForAgent = applyAgentProviderOverrides(provider, {
          defaultProviderCode: agentRow.defaultProviderCode,
          defaultModel: agentRow.defaultModel,
        });
        return new RemoteAgent({
          provider: providerForAgent,
          mistralAgentId: agentRow.mistralAgentId,
          agentName: agentRow.name
        });
      }

      // Custom DB-stored system prompt overrides the default for non-class agents
      const dbSystemPrompt = agentRow.agentPrompts?.[0]?.systemPrompt;
      const agentConfig = {
        allowedSubAgents: safeJson(agentRow.allowedSubAgents),
        allowedTools: safeJson(agentRow.allowedTools),
      };

      // Template-based agent: charge prompt + tools depuis la DB dynamiquement
      if (agentRow.templateId) {
        const providerForAgent = applyAgentProviderOverrides(provider, {
          defaultProviderCode: agentRow.defaultProviderCode,
          defaultModel: agentRow.defaultModel,
        });
        return new TemplateAgent({ ...agentRow, provider: providerForAgent });
      }

      const AgentClass = AGENT_CLASSES[agentId];
      if (AgentClass) {
        const systemPrompt = await loadPrompt(agentId, clientId);
        const providerForAgent = applyAgentProviderOverrides(provider, {
          defaultProviderCode: agentRow.defaultProviderCode,
          defaultModel: agentRow.defaultModel,
        });
        return new AgentClass({ provider: providerForAgent, systemPrompt, agentConfig });
      }

      // Generic workspace/custom agent
      const systemPrompt = dbSystemPrompt || await loadPrompt(agentId, clientId);
      const providerForAgent = applyAgentProviderOverrides(provider, {
        defaultProviderCode: agentRow.defaultProviderCode,
        defaultModel: agentRow.defaultModel,
      });
      return new BaseAgent({ agentId, provider: providerForAgent, systemPrompt, agentConfig });
    }
  } catch (err) {
    console.warn("[createAgent] Could not fetch agent from DB:", err.message);
  }

  // 2) Fallback for base agents not yet in DB (hardcoded classes)
  const AgentClass = AGENT_CLASSES[agentId];
  const systemPrompt = await loadPrompt(agentId, clientId);

  if (AgentClass) {
    return new AgentClass({ provider, systemPrompt });
  }

  return new BaseAgent({ agentId, provider, systemPrompt });
}

async function getAgentName(agentId) {
  const localNames = {
    "directeur": "Directeur",
    "commercial": "Commercial",
    "technicien": "Technicien",
    "generaliste": "Generaliste"
  };

  if (localNames[agentId]) return localNames[agentId];

  try {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { name: true }
    });
    if (agent) return agent.name;
  } catch { /* fall through */ }

  return agentId;
}

/**
 * Execute l'orchestration complete (non-streaming).
 */
export async function orchestrate({
  provider,
  userMessage,
  pageContext,
  sellsyData,
  conversationHistory = [],
  userRole = "client",
  clientId,
  conversationId = null,
  allowedAgents,
  requestedAgentId = null,
  tools = null,
  toolContext = null,
  knowledgeContext = null,
  thinkingMode = "low",
  tenantId = null
}) {
  const startTime = Date.now();
  logger.info("agent.dispatch", { userId: clientId, workspaceId: tenantId, conversationId, mode: "ask" });

  // Step 1: Determine which agent to use
  let agentId;
  let classification;
  const routingCandidates = getRoutingCandidates(allowedAgents);

  if (requestedAgentId && (allowedAgents.has(requestedAgentId) || requestedAgentId === GENERALIST_AGENT_ID)) {
    agentId = requestedAgentId;
    classification = {
      intent: requestedAgentId,
      agent: requestedAgentId,
      confidence: 1.0,
      reasoning: "Agent selectionne manuellement"
    };
  } else {
    classification = await classifyIntent(provider, userMessage, pageContext, userRole, routingCandidates);
    agentId = classification.agent;

    if (agentId !== GENERALIST_AGENT_ID && !allowedAgents.has(agentId)) {
      const fallbackAgent = pickPreferredSpecialist(allowedAgents);
      classification = {
        ...classification,
        intent: fallbackAgent,
        agent: fallbackAgent,
        confidence: Math.min(classification.confidence || 0.5, 0.5),
        reasoning: `${classification.reasoning || ""} Agent non autorise, fallback vers ${fallbackAgent}.`.trim()
      };
      agentId = fallbackAgent;
    }
  }

  // Step 2: Select the best skill for this request
  let skillResult = null;
  let activeSkillBlock = "";
  try {
    // Low mode prioritizes responsiveness; keep LLM routing in high mode.
    skillResult = await selectSkill(provider, userMessage, pageContext, { useLLM: thinkingMode === "high" });
    if (skillResult?.skill) {
      activeSkillBlock = formatSkillForInjection(skillResult.skill);
      console.log(`[Dispatcher] Skill selected: ${skillResult.chosen_skill} (confidence: ${Math.round((skillResult.confidence || 0) * 100)}%)`);
    }
  } catch (err) {
    console.warn("[Dispatcher] Skill routing failed, continuing without skill:", err.message);
  }

  // Step 3: Detect user language (once, propagated to agents and sub-agents)
  const userLanguage = detectUserLanguage(userMessage);

  // Step 4: Create and execute the agent
  const agent = await createAgent(agentId, provider, clientId, tenantId);

  if (!agent) {
    return {
      agentId,
      mode: "single-agent",
      answer: "Agent non disponible. Veuillez contacter l'administrateur.",
      classification,
      tokensInput: 0,
      tokensOutput: 0,
      responseTimeMs: Date.now() - startTime,
      error: "Agent class not found"
    };
  }

  // Enrichit le toolContext avec l'agentId et tenantId courants
  const effectiveTools = selectToolsForAgent(agentId, tools);
  const effectiveToolContext = buildToolContextForAgent(agentId, toolContext);

  const enrichedToolContext = effectiveToolContext
    ? { ...effectiveToolContext, agentId, tenantId }
    : { agentId, tenantId };

  const result = await agent.execute({
    userMessage,
    conversationHistory,
    sellsyData,
    pageContext,
    knowledgeContext,
    tools: effectiveTools,
    toolContext: enrichedToolContext,
    thinkingMode,
    clientId,
    conversationId,
    activeSkillBlock,
    userLanguage
  });

  const responseTimeMs = Date.now() - startTime;
  logger.info("agent.dispatch.done", { agentId, userId: clientId, workspaceId: tenantId, conversationId, responseTimeMs });

  return {
    agentId,
    agentName: await getAgentName(agentId),
    mode: "single-agent",
    answer: result.content,
    classification,
    skillRouting: skillResult ? {
      chosen_skill: skillResult.chosen_skill,
      confidence: skillResult.confidence,
      reason: skillResult.reason,
      secondary_skills: skillResult.secondary_skills || [],
      missing_inputs: skillResult.missing_inputs || []
    } : null,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    model: result.model,
    provider: result.provider,
    toolsUsed: result.toolsUsed || [],
    sourcesUsed: result.sourcesUsed || { web: [], sellsy: [], files: [] },
    responseTimeMs
  };
}

function _buildFallbackConversationTitle(userMessage) {
  const cleaned = (userMessage || "").trim().replace(/[^\w\s\u00C0-\u017F\-?!.,]/g, "").trim();
  if (cleaned.length <= 50) return cleaned || "Nouvelle discussion IA";
  const truncated = cleaned.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 20 ? truncated.slice(0, lastSpace) + "…" : truncated + "…";
}

/**
 * Generates a short smart conversation title from the first user message using the LLM.
 * Uses a short timeout to avoid delaying first streamed tokens.
 */
async function _generateSmartConversationTitle(userMessage, provider) {
  const fallback = _buildFallbackConversationTitle(userMessage);
  const timeoutMs = 700;

  try {
    const prompt = `Génère un titre très court (3 à 6 mots maximum) résumant cette demande. Renvoie uniquement le titre brut, sans ponctuation finale ni guillemets.\n\nDemande : "${userMessage}"`;
    const titlePromise = provider.chat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      maxTokens: 15
    }).then((result) => {
      let title = (result.content || "").replace(/["']/g, "").trim();
      title = title.replace(/\.$/, "");
      return title && title.length < 80 ? title : null;
    }).catch(() => null);

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });

    const title = await Promise.race([titlePromise, timeoutPromise]);
    if (title) return title;
  } catch (error) {
    console.warn("[Dispatcher] Smart title generation failed:", error.message);
  }

  return fallback;
}

/**
 * Orchestration en mode streaming.
 * L'agent gere ses propres sous-agents en interne.
 */
export async function* orchestrateStream({
  provider,
  userMessage,
  pageContext,
  sellsyData,
  conversationHistory = [],
  userRole = "client",
  clientId,
  conversationId,
  allowedAgents,
  requestedAgentId = null,
  tools = null,
  toolContext = null,
  thinkingMode = "low",
  knowledgeContext = null,
  isFirstMessage = false,
  tenantId = null
}) {
  const useLLMSkillRouting = thinkingMode === "high";
  logger.info("agent.dispatch", { userId: clientId, workspaceId: tenantId, conversationId, mode: "stream" });

  // Step 1: Emit conversation title on first message
  if (isFirstMessage) {
    const title = await _generateSmartConversationTitle(userMessage, provider);
    if (title) {
      yield { type: "conversation_title", title };
    }
  }

  // Kick off skill routing early to overlap with agent classification.
  const skillSelectionPromise = selectSkill(provider, userMessage, pageContext, {
    useLLM: useLLMSkillRouting
  }).catch((err) => {
    console.warn("[Dispatcher] Stream skill routing failed:", err.message);
    return null;
  });

  // Step 2: Determine which agent to use
  let agentId;
  let classification;
  const routingCandidates = getRoutingCandidates(allowedAgents);

  if (requestedAgentId && (allowedAgents.has(requestedAgentId) || requestedAgentId === GENERALIST_AGENT_ID)) {
    agentId = requestedAgentId;
    classification = { agent: agentId, intent: agentId, confidence: 1.0, reasoning: "Agent sélectionné manuellement" };
  } else {
    // Emit orchestrator thinking while classifying
    yield {
      type: "orchestrator_thinking",
      content: `Analyse de la demande... Contexte : ${pageContext?.type || "generic"}${pageContext?.entityName ? ` — ${pageContext.entityName}` : ""}`
    };
    classification = await classifyIntent(provider, userMessage, pageContext, userRole, routingCandidates);
    agentId = classification.agent;

    if (agentId !== GENERALIST_AGENT_ID && !allowedAgents.has(agentId)) {
      const fallbackAgent = pickPreferredSpecialist(allowedAgents);
      classification = {
        ...classification,
        intent: fallbackAgent,
        agent: fallbackAgent,
        confidence: Math.min(classification.confidence || 0.5, 0.5),
        reasoning: `${classification.reasoning || ""} Agent non autorise, fallback vers ${fallbackAgent}.`.trim()
      };
      agentId = fallbackAgent;
    }
    // Emit routing decision
    yield {
      type: "orchestrator_thinking",
      content: `Routage vers l'agent ${await getAgentName(agentId)} (confiance : ${Math.round((classification.confidence || 0.5) * 100)}%). ${classification.reasoning || ""}`
    };
  }

  // Step 3: Select the best skill
  let skillResult = null;
  let activeSkillBlock = "";
  try {
    skillResult = await skillSelectionPromise;
    if (skillResult?.skill) {
      activeSkillBlock = formatSkillForInjection(skillResult.skill);
      console.log(`[Dispatcher] Stream skill selected: ${skillResult.chosen_skill} (confidence: ${Math.round((skillResult.confidence || 0) * 100)}%)`);
    }
  } catch {
    // Errors are already handled in skillSelectionPromise.
  }

  // Step 4: Detect user language (once, propagated to agents and sub-agents)
  const userLanguage = detectUserLanguage(userMessage);

  // Step 5: Create the agent (pass tenantId for workspace isolation)
  const agent = await createAgent(agentId, provider, clientId, tenantId);
  if (!agent) {
    yield { type: "chunk", content: "Agent non disponible ou accès refusé." };
    yield { type: "done", content: "Agent non disponible ou accès refusé.", toolsUsed: [], sourcesUsed: { web: [], sellsy: [], files: [] } };
    return;
  }

  yield {
    type: "agent_selected",
    agentId,
    agentName: await getAgentName(agentId),
    classification,
    skillRouting: skillResult ? { chosen_skill: skillResult.chosen_skill, confidence: skillResult.confidence, reason: skillResult.reason } : null
  };

  // Enrichit le toolContext avec l'agentId et tenantId courants
  const effectiveTools = selectToolsForAgent(agentId, tools);
  const effectiveToolContext = buildToolContextForAgent(agentId, toolContext);

  const enrichedToolContext = effectiveToolContext
    ? { ...effectiveToolContext, agentId, tenantId }
    : { agentId, tenantId };

  // Step 6: Stream from the agent (which internally manages sub-agents)
  try {
    for await (const event of agent.executeStream({
      userMessage,
      conversationHistory,
      sellsyData,
      pageContext,
      knowledgeContext,
      tools: effectiveTools,
      toolContext: enrichedToolContext,
      thinkingMode,
      clientId,
      conversationId,
      activeSkillBlock,
      userLanguage
    })) {
      yield event;
    }
  } catch (error) {
    console.error(`[Dispatcher] Agent stream error in conversation ${conversationId}:`, error);
    yield {
      type: "agent_thinking",
      content: `Oups ! Une erreur est survenue lors de l'exécution de l'agent : ${error.message}.`
    };
    yield {
      type: "done",
      content: `Je m'excuse, mais j'ai rencontré une difficulté technique en traitant votre demande (${error.message}). Veuillez réessayer ou contacter le support si le problème persiste.`,
      toolsUsed: [],
      sourcesUsed: { web: [], sellsy: [], files: [] }
    };
  }
}
