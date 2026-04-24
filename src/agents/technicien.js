/**
 * Technicien Agent — Agent spécialisé technique/intégration.
 * Remplace le Solution Architect Copilot avec l'architecture sub-agents.
 * Focus : configuration Sellsy, API, automatisation, documentation technique.
 */

import { BaseAgent } from "./base-agent.js";
import { executePipeline } from "../tools/builtin/pipeline.js";

export class TechnicienAgent extends BaseAgent {
  constructor({ provider, systemPrompt }) {
    super({ agentId: "technicien", provider, systemPrompt });
  }

  buildContextBlock(sellsyData, pageContext) {
    if (!sellsyData?.data) {
      return pageContext?.type
        ? `Page Sellsy : ${pageContext.type} — Contexte technique disponible.`
        : "Aucun contexte Sellsy.";
    }

    const parts = [];
    const { data, contextType } = sellsyData;

    // Technical view: show IDs, API endpoints, field counts
    if (data.company) {
      parts.push(`## Societe (vue technique)`);
      parts.push(`- **ID** : ${data.company.id || pageContext?.entityId || "N/A"}`);
      parts.push(`- **Nom** : ${data.company.name}`);
      parts.push(`- **Champs** : ${Object.keys(data.company).length}`);
    }

    if (data.opportunity) {
      parts.push(`## Opportunite (vue technique)`);
      parts.push(`- **ID** : ${data.opportunity.id || pageContext?.entityId || "N/A"}`);
      parts.push(`- **Nom** : ${data.opportunity.name}`);
      parts.push(`- **Pipeline** : ${data.opportunity.pipeline?.name || "N/A"}`);
      parts.push(`- **Etape** : ${data.opportunity.step?.name || data.opportunity.step || "N/A"}`);
    }

    if (data.contact) {
      parts.push(`## Contact (vue technique)`);
      parts.push(`- **ID** : ${data.contact.id || "N/A"}`);
      parts.push(`- **Nom** : ${data.contact.fullName}`);
    }

    return parts.length > 0 ? parts.join("\n") : JSON.stringify(sellsyData.data, null, 2);
  }

  async _createPlan({ userMessage, sellsyData, pageContext, toolContext, thinkingMode }) {
    const plan = [];

    if (toolContext?.uploadedFiles?.length > 0) {
      for (let i = 0; i < toolContext.uploadedFiles.length; i++) {
        plan.push({
          type: "file",
          instruction: `Analyse le fichier technique ${toolContext.uploadedFiles[i].originalname || `#${i}`} pour : "${userMessage}"`
        });
      }
    }

    if (toolContext?.sellsyClient) {
      const entityInfo = pageContext?.entityId ? `Entite ID: ${pageContext.entityId} (type: ${pageContext.type || "generic"})` : "";
      plan.push({
        type: "sellsy",
        instruction: `Recupere les donnees techniques pour : "${userMessage}". ${entityInfo}`
      });
    }

    // Technical agent more often needs web search (API docs, integrations, etc.)
    if (toolContext?.tavilyApiKey) {
      if (thinkingMode === "high" || this._needsWebSearch(userMessage)) {
        plan.push({
          type: "web",
          instruction: `Recherche documentation technique et solutions pour : "${userMessage}". Focus : API Sellsy, integrations, automatisation, bonnes pratiques.`
        });
      }
    }

    return plan;
  }

  _needsWebSearch(message) {
    return /internet|web|recherche|site|api|documentation|doc|webhook|zapier|make|integration|automatis|url|http|guide|tuto/i.test(message);
  }

  async execute({
    userMessage, conversationHistory = [], sellsyData = null, pageContext = null,
    knowledgeContext = null, tools = null, toolContext = null, thinkingMode = "low",
    userLanguage = null
  }) {
    const plan = await this._createPlan({ userMessage, sellsyData, pageContext, toolContext, thinkingMode });

    if (plan.length === 0) {
      return super.execute({ userMessage, conversationHistory, sellsyData, pageContext, knowledgeContext, tools, toolContext, thinkingMode, userLanguage });
    }

    const contextBlock = this.buildContextBlock(sellsyData, pageContext);
    const pageContextBlock = this.buildPageContextBlock(pageContext);
    let globalContext = "";
    if (pageContextBlock) globalContext += `Page Sellsy:\n${pageContextBlock}\n`;
    if (contextBlock) globalContext += `\nDonnees CRM:\n${contextBlock}\n`;
    if (knowledgeContext) globalContext += `\nBase de connaissances:\n${knowledgeContext}\n`;

    const pipelineResult = await executePipeline({ plan, provider: this.provider, toolContext, thinkingMode, globalContext });

    return this._synthesize({ userMessage, conversationHistory, pipelineResult, knowledgeContext, globalContext, thinkingMode, userLanguage });
  }

  async *executeStream({
    userMessage, conversationHistory = [], sellsyData = null, pageContext = null,
    knowledgeContext = null, tools = null, toolContext = null, thinkingMode = "low",
    userLanguage = null
  }) {
    const plan = await this._createPlan({ userMessage, sellsyData, pageContext, toolContext, thinkingMode });

    if (plan.length === 0) {
      yield* super.executeStream({ userMessage, conversationHistory, sellsyData, pageContext, knowledgeContext, tools, toolContext, thinkingMode, userLanguage });
      return;
    }

    // 1. Agent thinking
    yield {
      type: "agent_thinking",
      agentId: this.agentId,
      content: `Analyse technique de la demande. Préparation de ${plan.length} sous-agent(s) : ${plan.map((t) => t.type).join(", ")}.`
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
        content: "Synthèse technique et formulation de la solution..."
      };
    }

    // 6. Synthesize and stream final response
    const finalResponse = await this._synthesize({ userMessage, conversationHistory, pipelineResult, knowledgeContext, globalContext, thinkingMode, userLanguage });

    const words = (finalResponse.content || "").split(/(\s+)/);
    for (const word of words) {
      if (word) yield { chunk: word, done: false };
    }

    yield {
      chunk: "", done: true,
      toolsUsed: finalResponse.toolsUsed || [],
      sourcesUsed: finalResponse.sourcesUsed || { web: [], sellsy: [], files: [] }
    };
  }

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

    const synthesisPrompt = `Tu es le Technicien Agent de Boatswain. Réponds directement comme un collègue technicien expert.

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
- Longue (> 5 phrases) UNIQUEMENT si l'utilisateur demande explicitement un tutoriel, un guide ou "plus de détails".
- TON : direct, précis, conversationnel — comme entre collègues devant un écran.
- Si le besoin est flou, pose une question ciblée plutôt que de supposer.
- Blocs de code uniquement si vraiment nécessaires pour la compréhension.
- N'utilise JAMAIS "D'après les recherches", "Les résultats montrent".
- NE PAS inclure de JSON système brut.${userLanguage?.instruction ? `\n\n${userLanguage.instruction}` : ""}`;

    const messages = [
      ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: synthesisPrompt }
    ];

    const result = await this.provider.chat({
      systemPrompt: this.systemPrompt, messages, temperature: 0.7, maxTokens: 4096
    });

    const cleanContent = (result.content || "").replace(/```json[\s\S]*?```/g, (match) => {
      return match.includes('"sources"') || match.includes('"sub_agents"') ? "" : match;
    }).trim();

    console.log(`[Technicien] _synthesize input: ${userMessage.slice(0, 100)} | output length: ${cleanContent.length}`);

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
