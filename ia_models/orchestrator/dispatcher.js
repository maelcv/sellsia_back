/**
 * Dispatcher / Orchestrateur — Le cerveau central de Sellsia.
 *
 * Recoit une demande utilisateur et :
 * 1. Identifie l'intention via LLM (ou agent explicitement demande)
 * 2. Route vers le bon agent (Directeur, Commercial, Technicien)
 * 3. L'agent gere en interne ses sous-agents (File → Sellsy → Web)
 * 4. Journalise l'orchestration
 */

import { SYSTEM_PROMPTS } from "../prompts/system/defaults.js";
import { loadPrompt, interpolatePrompt } from "../prompts/loader.js";
import { DirecteurAgent } from "../agents/directeur.js";
import { CommercialAgent } from "../agents/commercial.js";
import { TechnicienAgent } from "../agents/technicien.js";
import { BaseAgent, detectUserLanguage } from "../agents/base-agent.js";
import { prisma, logProviderError } from "../../src/prisma.js";
import { selectSkill } from "../skills/router.js";
import { formatSkillForInjection } from "../skills/catalog.js";

const AGENT_CLASSES = {
  "directeur": DirecteurAgent,
  "commercial": CommercialAgent,
  "technicien": TechnicienAgent
};

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
 * Retourne l'agent a utiliser : commercial, directeur ou technicien.
 */
export async function classifyIntent(provider, userMessage, pageContext, userRole, allowedAgents = null) {
  let availableAgentsInfo = "";
  if (allowedAgents && allowedAgents.size > 0) {
    const agentDescriptions = {
      "commercial": "Commercial — aide a la vente, briefs comptes, relances, opportunites, contacts, devis",
      "directeur": "Directeur — reporting, analyse pipeline, KPIs, previsions, pilotage direction",
      "technicien": "Technicien — configuration Sellsy, API, automatisation, integration technique"
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

    return {
      intent: result.intent || "commercial",
      agent: result.agent || "commercial",
      confidence: result.confidence || 0.5,
      reasoning: result.reasoning || ""
    };
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

  const defaultAgent = has("commercial") ? "commercial" : (allowedAgents ? [...allowedAgents][0] : "commercial");
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
        allowedSubAgents: true,
        allowedTools: true,
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
        return new RemoteAgent({
          provider,
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

      const AgentClass = AGENT_CLASSES[agentId];
      if (AgentClass) {
        const systemPrompt = await loadPrompt(agentId, clientId);
        return new AgentClass({ provider, systemPrompt, agentConfig });
      }

      // Generic workspace/custom agent
      const systemPrompt = dbSystemPrompt || await loadPrompt(agentId, clientId);
      return new BaseAgent({ agentId, provider, systemPrompt, agentConfig });
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
    "technicien": "Technicien"
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

  // Step 1: Determine which agent to use
  let agentId;
  let classification;

  if (requestedAgentId && allowedAgents.has(requestedAgentId)) {
    agentId = requestedAgentId;
    classification = {
      intent: requestedAgentId,
      agent: requestedAgentId,
      confidence: 1.0,
      reasoning: "Agent selectionne manuellement"
    };
  } else {
    classification = await classifyIntent(provider, userMessage, pageContext, userRole, allowedAgents);
    agentId = classification.agent;
    // Ensure agent is allowed
    if (!allowedAgents.has(agentId)) {
      agentId = [...allowedAgents][0];
    }
  }

  // Step 2: Select the best skill for this request
  let skillResult = null;
  let activeSkillBlock = "";
  try {
    skillResult = await selectSkill(provider, userMessage, pageContext, { useLLM: true });
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
  const enrichedToolContext = toolContext
    ? { ...toolContext, agentId, tenantId }
    : { agentId, tenantId };

  const result = await agent.execute({
    userMessage,
    conversationHistory,
    sellsyData,
    pageContext,
    knowledgeContext,
    tools,
    toolContext: enrichedToolContext,
    thinkingMode,
    clientId,
    conversationId,
    activeSkillBlock,
    userLanguage
  });

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
    responseTimeMs: Date.now() - startTime
  };
}

/**
 * Generates a short smart conversation title from the first user message using the LLM.
 */
async function _generateSmartConversationTitle(userMessage, provider) {
  try {
    const prompt = `Génère un titre très court (3 à 6 mots maximum) résumant cette demande. Renvoie uniquement le titre brut, sans ponctuation finale ni guillemets.\n\nDemande : "${userMessage}"`;
    const result = await provider.chat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      maxTokens: 15
    });
    let title = (result.content || "").replace(/["']/g, "").trim();
    title = title.replace(/\.$/, ""); // remove trailing dot
    
    // Check reasonable length / sanity
    if (title && title.length < 80) return title;
  } catch (error) {
    console.warn("[Dispatcher] Smart title generation failed:", error.message);
  }

  // Fallback
  const cleaned = (userMessage || "").trim().replace(/[^\w\s\u00C0-\u017F\-?!.,]/g, "").trim();
  if (cleaned.length <= 50) return cleaned || "Nouvelle discussion IA";
  const truncated = cleaned.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 20 ? truncated.slice(0, lastSpace) + "…" : truncated + "…";
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
  // Step 1: Emit conversation title on first message
  if (isFirstMessage) {
    const title = await _generateSmartConversationTitle(userMessage, provider);
    if (title) {
      yield { type: "conversation_title", title };
    }
  }

  // Step 2: Determine which agent to use
  let agentId;
  let classification;

  if (requestedAgentId && allowedAgents.has(requestedAgentId)) {
    agentId = requestedAgentId;
    classification = { agent: agentId, intent: agentId, confidence: 1.0, reasoning: "Agent sélectionné manuellement" };
  } else {
    // Emit orchestrator thinking while classifying
    yield {
      type: "orchestrator_thinking",
      content: `Analyse de la demande... Contexte : ${pageContext?.type || "generic"}${pageContext?.entityName ? ` — ${pageContext.entityName}` : ""}`
    };
    classification = await classifyIntent(provider, userMessage, pageContext, userRole, allowedAgents);
    agentId = classification.agent;
    if (!allowedAgents.has(agentId)) {
      agentId = [...allowedAgents][0];
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
    skillResult = await selectSkill(provider, userMessage, pageContext, { useLLM: true });
    if (skillResult?.skill) {
      activeSkillBlock = formatSkillForInjection(skillResult.skill);
      console.log(`[Dispatcher] Stream skill selected: ${skillResult.chosen_skill} (confidence: ${Math.round((skillResult.confidence || 0) * 100)}%)`);
    }
  } catch (err) {
    console.warn("[Dispatcher] Stream skill routing failed:", err.message);
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
  const enrichedToolContext = toolContext
    ? { ...toolContext, agentId, tenantId }
    : { agentId, tenantId };

  // Step 6: Stream from the agent (which internally manages sub-agents)
  try {
    for await (const event of agent.executeStream({
      userMessage,
      conversationHistory,
      sellsyData,
      pageContext,
      knowledgeContext,
      tools,
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
