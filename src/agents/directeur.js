/**
 * Directeur Agent — Agent manager/directeur pour le pilotage commercial.
 * Remplace l'Executive Copilot avec l'architecture sub-agents.
 * Focus : KPI, pipeline, reporting, prévisions, recommandations.
 */

import { BaseAgent } from "./base-agent.js";
import { executePipeline } from "../tools/builtin/pipeline.js";

export class DirecteurAgent extends BaseAgent {
  constructor({ provider, systemPrompt }) {
    super({ agentId: "directeur", provider, systemPrompt });
  }

  buildContextBlock(sellsyData, pageContext) {
    if (!sellsyData?.data) {
      return pageContext?.type
        ? `Page Sellsy : ${pageContext.type} — Connectez Sellsy pour l'analyse pipeline et le reporting.`
        : "Aucun contexte Sellsy.";
    }

    const parts = [];
    const { data, contextType } = sellsyData;

    if (contextType === "opportunity" && data.opportunity) {
      const o = data.opportunity;
      parts.push(`## Opportunite (vue direction)`);
      parts.push(`- **Deal** : ${o.name}`);
      parts.push(`- **Valeur** : ${o.amount ? o.amount + " €" : "Non valorise"}`);
      parts.push(`- **Probabilite** : ${o.probability || "N/A"}%`);
      parts.push(`- **Etape** : ${o.step?.name || o.step || "N/A"}`);
      parts.push(`- **Statut** : ${o.status}`);
      if (o.updatedAt) {
        const days = Math.floor((Date.now() - new Date(o.updatedAt).getTime()) / 86400000);
        parts.push(`- **Jours depuis MAJ** : ${days}`);
        if (days > 14) parts.push(`- **ALERTE** : Stagne depuis ${days} jours`);
      }
      if (data.company) {
        parts.push(`\n## Societe associee`);
        parts.push(`- **Nom** : ${data.company.name}`);
        if (data.company.email) parts.push(`- **Email** : ${data.company.email}`);
      }
    }

    if (contextType === "company" && data.company) {
      parts.push(`## Compte client`);
      parts.push(`- **Societe** : ${data.company.name}`);
      parts.push(`- **Client depuis** : ${data.company.createdAt || "N/A"}`);
      if (data.recentActivities) {
        parts.push(`- **Activites recentes** : ${data.recentActivities.length} interactions`);
      }
    }

    if (data.pipelineAnalysis) {
      parts.push(`\n## Analyse Pipeline`);
      for (const pipe of data.pipelineAnalysis) {
        parts.push(`### ${pipe.pipelineName}`);
        parts.push(`- Total opportunites : ${pipe.totalOpportunities}`);
        parts.push(`- Valeur totale : ${pipe.totalAmount} €`);
        parts.push(`- Stagnantes (>30j) : ${pipe.staleOpportunities}`);
      }
    }

    return parts.length > 0 ? parts.join("\n") : JSON.stringify(sellsyData.data, null, 2);
  }

  /**
   * Create a sub-agent execution plan from the user's request.
   */
  async _createPlan({ userMessage, sellsyData, pageContext, toolContext, thinkingMode }) {
    const plan = [];

    // File sub-agents if files are uploaded
    if (toolContext?.uploadedFiles?.length > 0) {
      for (let i = 0; i < toolContext.uploadedFiles.length; i++) {
        plan.push({
          type: "file",
          instruction: `Analyse le fichier ${toolContext.uploadedFiles[i].originalname || `#${i}`} et extrais les informations pertinentes pour cette demande : "${userMessage}"`
        });
      }
    }

    // Sellsy sub-agents if connected
    if (toolContext?.sellsyClient) {
      const entityInfo = this._getEntityInfo(sellsyData, pageContext);
      const msg = userMessage.toLowerCase();
      let subAgentType = "sellsy";
      if (/(pipeline|stagnant|risque|perte|dynamique|oubli)/.test(msg)) {
        subAgentType = "pipeline-diagnostic";
      }
      plan.push({
        type: subAgentType,
        instruction: `Fournis les données et l'analyse CRM pour répondre à : "${userMessage}". ${entityInfo}`
      });
    }

    // Web sub-agents if Tavily is configured
    if (toolContext?.tavilyApiKey) {
      const entityName = sellsyData?.data?.company?.name || pageContext?.entityName || "";
      if (thinkingMode === "high" || this._needsWebSearch(userMessage)) {
        plan.push({
          type: "web",
          instruction: `Recherche des informations web pertinentes pour : "${userMessage}". ${entityName ? `Entite concernee : ${entityName}` : ""}`
        });
      }
    }

    return plan;
  }

  _getEntityInfo(sellsyData, pageContext) {
    const parts = [];
    if (pageContext?.entityId) parts.push(`ID entite: ${pageContext.entityId}`);
    if (pageContext?.entityName) parts.push(`Nom: ${pageContext.entityName}`);
    if (pageContext?.type) parts.push(`Type: ${pageContext.type}`);
    if (sellsyData?.data?.company?.name) parts.push(`Societe: ${sellsyData.data.company.name}`);
    return parts.length > 0 ? `Contexte : ${parts.join(", ")}` : "";
  }

  _needsWebSearch(message) {
    const webKeywords = /internet|web|recherche|site|linkedin|actualit|news|march|concurrent|tendance|secteur|url|http/i;
    return webKeywords.test(message);
  }

  /**
   * Override execute() to use the sub-agent pipeline.
   */
  async execute({
    userMessage,
    conversationHistory = [],
    sellsyData = null,
    pageContext = null,
    knowledgeContext = null,
    tools = null,
    toolContext = null,
    thinkingMode = "low",
    userLanguage = null
  }) {
    // Build the plan
    const plan = await this._createPlan({ userMessage, sellsyData, pageContext, toolContext, thinkingMode });

    // If no sub-agents needed, fall back to direct response
    if (plan.length === 0) {
      return super.execute({
        userMessage, conversationHistory, sellsyData, pageContext,
        knowledgeContext, tools, toolContext, thinkingMode, userLanguage
      });
    }

    // Build initial context
    const contextBlock = this.buildContextBlock(sellsyData, pageContext);
    const pageContextBlock = this.buildPageContextBlock(pageContext);
    let globalContext = "";
    if (pageContextBlock) globalContext += `Page Sellsy:\n${pageContextBlock}\n`;
    if (contextBlock) globalContext += `\nDonnees CRM:\n${contextBlock}\n`;
    if (knowledgeContext) globalContext += `\nBase de connaissances:\n${knowledgeContext}\n`;

    // Execute the pipeline
    const pipelineResult = await executePipeline({
      plan,
      provider: this.provider,
      toolContext,
      thinkingMode,
      globalContext
    });

    // Synthesize final response
    const finalResponse = await this._synthesize({
      userMessage,
      conversationHistory,
      pipelineResult,
      knowledgeContext,
      globalContext,
      thinkingMode,
      userLanguage
    });

    return finalResponse;
  }

  /**
   * Override executeStream() to use the sub-agent pipeline with events.
   */
  async *executeStream({
    userMessage,
    conversationHistory = [],
    sellsyData = null,
    pageContext = null,
    knowledgeContext = null,
    tools = null,
    toolContext = null,
    thinkingMode = "low",
    userLanguage = null
  }) {
    const plan = await this._createPlan({ userMessage, sellsyData, pageContext, toolContext, thinkingMode });

    if (plan.length === 0) {
      yield* super.executeStream({
        userMessage, conversationHistory, sellsyData, pageContext,
        knowledgeContext, tools, toolContext, thinkingMode, userLanguage
      });
      return;
    }

    // 1. Agent thinking
    yield {
      type: "agent_thinking",
      agentId: this.agentId,
      content: `Analyse de la demande de pilotage. Préparation de ${plan.length} sous-agent(s) : ${plan.map((t) => t.type).join(", ")}.`
    };

    // 2. Agent plan
    yield {
      type: "agent_plan",
      agentId: this.agentId,
      plan: plan.map((t) => ({ type: t.type, instruction: t.instruction }))
    };

    // 3. Build context
    const contextBlock = this.buildContextBlock(sellsyData, pageContext);
    const pageContextBlock = this.buildPageContextBlock(pageContext);
    let globalContext = "";
    if (pageContextBlock) globalContext += `Page Sellsy:\n${pageContextBlock}\n`;
    if (contextBlock) globalContext += `\nDonnees CRM:\n${contextBlock}\n`;
    if (knowledgeContext) globalContext += `\nBase de connaissances:\n${knowledgeContext}\n`;

    // 4. Stream pipeline events in real-time
    const eventQueue = [];
    let pipelineDone = false;
    let pipelineError = null;
    let pipelineResult;

    executePipeline({
      plan, provider: this.provider, toolContext, thinkingMode, globalContext,
      onEvent: (evt) => eventQueue.push(evt)
    }).then((result) => {
      pipelineResult = result;
      pipelineDone = true;
    }).catch((err) => {
      pipelineError = err;
      pipelineDone = true;
    });

    while (!pipelineDone) {
      while (eventQueue.length > 0) yield eventQueue.shift();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    if (pipelineError) throw pipelineError;
    while (eventQueue.length > 0) yield eventQueue.shift();

    // 5. Pre-response thinking (high mode)
    if (thinkingMode === "high") {
      yield {
        type: "agent_pre_response_thinking",
        agentId: this.agentId,
        content: "Analyse des données de pilotage et formulation du rapport..."
      };
    }

    // 6. Synthesize and stream final response
    const finalResponse = await this._synthesize({
      userMessage, conversationHistory, pipelineResult, knowledgeContext, globalContext, thinkingMode, userLanguage
    });

    const words = (finalResponse.content || "").split(/(\s+)/);
    for (const word of words) {
      if (word) yield { chunk: word, done: false };
    }

    yield {
      chunk: "",
      done: true,
      toolsUsed: finalResponse.toolsUsed || [],
      sourcesUsed: finalResponse.sourcesUsed || { web: [], sellsy: [], files: [] }
    };
  }

  /**
   * Synthesize the final response from sub-agent results.
   */
  async _synthesize({ userMessage, conversationHistory, pipelineResult, knowledgeContext, globalContext, thinkingMode, userLanguage = null }) {
    const { results, totalTokensInput, totalTokensOutput } = pipelineResult;

    const resultsSummary = results
      .map((r, i) => `### Résultat sous-agent ${i + 1}\n${r.output || "Aucun résultat."}`)
      .join("\n\n");

    const allSources = results.flatMap((r) => r.sources || []);
    const sourcesUsed = {
      web: allSources
        .filter((s) => typeof s === "string" && (s.startsWith("http") || s.includes("://")))
        .map((url) => ({ url, title: url, snippet: "" })),
      sellsy: allSources
        .filter((s) => typeof s === "string" && s.startsWith("sellsy:"))
        .map((s) => {
          const parts = s.replace("sellsy:", "").split("#");
          return { objectType: parts[0] || "sellsy", objectId: parts[1] || "", label: `${parts[0] || "sellsy"}${parts[1] ? ` #${parts[1]}` : ""}` };
        }),
      files: allSources
        .filter((s) => typeof s === "string" && s.startsWith("file:"))
        .map((s) => ({ filename: s.replace("file:", ""), tool: "parse" }))
    };

    const synthesisPrompt = `Tu es le Directeur Agent de Sellsia. Réponds directement comme un collègue expert en pilotage commercial.

DEMANDE : ${userMessage}

DONNÉES COLLECTÉES :
${resultsSummary}

${knowledgeContext ? `BASE DE CONNAISSANCES :\n${knowledgeContext}\n` : ""}
${globalContext ? `CONTEXTE CRM ACTUEL :\n${globalContext}\n` : ""}
LANGUE — RÈGLE ABSOLUE :
- Tu DOIS répondre dans la MÊME LANGUE que celle utilisée par l'utilisateur dans sa DEMANDE ci-dessus.
- Si la demande est en anglais, réponds en anglais. En espagnol, en espagnol. En français, en français. Etc.
- Détecte la langue et adapte-toi automatiquement. Ne traduis pas, réponds directement dans sa langue.

RÈGLES ABSOLUES :
- LONGUEUR PAR DÉFAUT : 1 à 3 phrases maximum. Exception tolérée jusqu'à 5 si vraiment nécessaire.
- Longue (> 5 phrases) UNIQUEMENT si l'utilisateur demande explicitement un rapport, un bilan ou "plus de détails".
- TON : direct, factuel, orienté décision — comme en réunion de pilotage.
- Fusionne les données naturellement, NE MENTIONNE JAMAIS les sous-agents ou le processus interne.
- N'utilise JAMAIS "D'après les données", "Les résultats montrent", "Suite à mes recherches".
- Format Markdown structuré (métriques → analyse → recos) uniquement pour les rapports explicitement demandés.
- NE PAS inclure de JSON ou références système.${userLanguage?.instruction ? `\n\n${userLanguage.instruction}` : ""}`;

    const messages = [
      ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: synthesisPrompt }
    ];

    const result = await this.provider.chat({
      systemPrompt: this.systemPrompt, messages, temperature: 0.7, maxTokens: 4096
    });

    const cleanContent = (result.content || "").replace(/```json[\s\S]*?```/g, "").replace(/```[\s\S]*?```/g, (match) => {
      return match.includes('"sources"') || match.includes('"sub_agents"') ? "" : match;
    }).trim();

    console.log(`[Directeur] _synthesize input: ${userMessage.slice(0, 100)} | output length: ${cleanContent.length}`);

    return {
      content: cleanContent,
      tokensInput: totalTokensInput + (result.tokensInput || 0),
      tokensOutput: totalTokensOutput + (result.tokensOutput || 0),
      model: result.model,
      provider: result.provider,
      toolsUsed: results.map((r) => ({ subAgentType: r.demande, sources: r.sources })),
      sourcesUsed
    };
  }
}
