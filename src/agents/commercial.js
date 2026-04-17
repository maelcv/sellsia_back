/**
 * Commercial Agent — Agent spécialisé pour les ventes et relations clients.
 * Remplace le Sales Copilot avec l'architecture sub-agents.
 * Focus : brief compte, relances, aide à la vente, suivi opportunités.
 */

import { BaseAgent } from "./base-agent.js";
import { executePipeline } from "../tools/builtin/pipeline.js";

export class CommercialAgent extends BaseAgent {
  constructor({ provider, systemPrompt }) {
    super({ agentId: "commercial", provider, systemPrompt });
  }

  buildContextBlock(sellsyData, pageContext) {
    if (!sellsyData?.data) {
      return pageContext?.type
        ? `Page Sellsy : ${pageContext.type} — Connectez Sellsy pour enrichir les reponses.`
        : "Aucun contexte Sellsy.";
    }

    const parts = [];
    const { data, contextType } = sellsyData;

    if (contextType === "company" && data.company) {
      const c = data.company;
      parts.push(`## Fiche Societe`);
      parts.push(`- **Nom** : ${c.name}`);
      if (c.email) parts.push(`- **Email** : ${c.email}`);
      if (c.phone) parts.push(`- **Telephone** : ${c.phone}`);
      if (c.website) parts.push(`- **Site** : ${c.website}`);
      if (c.note) parts.push(`- **Notes** : ${c.note}`);
      if (c.siret) parts.push(`- **SIRET** : ${c.siret}`);
      if (c.mainContactId) parts.push(`- **Contact principal (ID)** : ${c.mainContactId}`);
      if (c.createdAt) parts.push(`- **Client depuis** : ${c.createdAt}`);
      if (data.mainContact) {
        const mc = data.mainContact;
        parts.push(`\n## Contact principal`);
        parts.push(`- **Nom** : ${mc.fullName}`);
        if (mc.email) parts.push(`- **Email** : ${mc.email}`);
        if (mc.phone) parts.push(`- **Telephone** : ${mc.phone}`);
        if (mc.mobile) parts.push(`- **Mobile** : ${mc.mobile}`);
        if (mc.position) parts.push(`- **Poste** : ${mc.position}`);
      }
      if (data.recentActivities?.length > 0) {
        parts.push(`\n## Dernieres activites (${data.recentActivities.length})`);
        for (const act of data.recentActivities.slice(0, 5)) {
          parts.push(`- ${act.type || "Activite"} : ${act.subject || act.description || "N/A"} (${act.created || ""})`);
        }
      }
    }

    if (contextType === "opportunity" && data.opportunity) {
      const o = data.opportunity;
      parts.push(`## Opportunite`);
      parts.push(`- **Nom** : ${o.name}`);
      parts.push(`- **Montant** : ${o.amount ? o.amount + " €" : "Non renseigne"}`);
      parts.push(`- **Probabilite** : ${o.probability ? o.probability + "%" : "N/A"}`);
      parts.push(`- **Etape** : ${o.step?.name || o.step || "N/A"}`);
      parts.push(`- **Statut** : ${o.status || "N/A"}`);
      if (o.dueDate || o.closeDate) parts.push(`- **Closing prevu** : ${o.dueDate || o.closeDate}`);
      if (data.company) {
        parts.push(`\n## Societe associee`);
        parts.push(`- **Nom** : ${data.company.name}`);
        if (data.company.email) parts.push(`- **Email** : ${data.company.email}`);
      }
      if (data.contact) {
        parts.push(`\n## Contact associe`);
        parts.push(`- **Nom** : ${data.contact.fullName}`);
        if (data.contact.email) parts.push(`- **Email** : ${data.contact.email}`);
        if (data.contact.position) parts.push(`- **Poste** : ${data.contact.position}`);
      }
    }

    if (contextType === "contact" && data.contact) {
      const c = data.contact;
      parts.push(`## Contact`);
      parts.push(`- **Nom** : ${c.fullName}`);
      if (c.email) parts.push(`- **Email** : ${c.email}`);
      if (c.phone) parts.push(`- **Telephone** : ${c.phone}`);
      if (c.position) parts.push(`- **Poste** : ${c.position}`);
    }

    if (contextType === "quote" && data.quote) {
      const q = data.quote;
      parts.push(`## Devis`);
      parts.push(`- **Numero** : ${q.number || "N/A"}`);
      parts.push(`- **Objet** : ${q.subject || "N/A"}`);
      parts.push(`- **Montant** : ${q.totalAmount ? q.totalAmount + " " + (q.currency || "€") : "N/A"}`);
      parts.push(`- **Statut** : ${q.status || "N/A"}`);
    }

    return parts.length > 0 ? parts.join("\n") : JSON.stringify(sellsyData.data, null, 2);
  }

  async _createPlan({ userMessage, sellsyData, pageContext, toolContext, thinkingMode }) {
    const plan = [];

    if (toolContext?.uploadedFiles?.length > 0) {
      for (let i = 0; i < toolContext.uploadedFiles.length; i++) {
        plan.push({
          type: "file",
          instruction: `Analyse le fichier ${toolContext.uploadedFiles[i].originalname || `#${i}`} pour : "${userMessage}"`
        });
      }
    }

    if (toolContext?.sellsyClient && !this._isConversational(userMessage)) {
      const entityName = sellsyData?.data?.company?.name || sellsyData?.data?.opportunity?.name || sellsyData?.data?.contact?.fullName || pageContext?.entityName || "";
      const entityType = pageContext?.type || "generic";
      const entityId = pageContext?.entityId || "";

      // Build explicit ID mapping so the sub-agent knows exactly what each ID refers to
      const idMapping = this._buildIdMapping(sellsyData, pageContext);

      // Routing logic based on intent
      const msg = userMessage.toLowerCase();
      let subAgentType = "sellsy"; // fallback
      if (/(r[eé]dige|email|mail|linkedin|message|écris)/.test(msg)) {
        subAgentType = "sales-writer";
      } else if (/(que dois[\s-]je faire|priorit[eé]|strat[eé]gie|recommande|next best action)/.test(msg)) {
        subAgentType = "sales-strategy";
      } else if (/(pipeline|stagnant|risque|oubli[eé])/.test(msg) && entityType !== "contact" && entityType !== "company") {
        subAgentType = "pipeline-diagnostic";
      } else if (/(brief|analyse|potentiel|synth[eé]tise)/.test(msg)) {
        subAgentType = "sales-analysis";
      }

      plan.push({
        type: subAgentType,
        instruction: `Réponds à : "${userMessage}". Entité : ${entityName || "non spécifié"} (type: ${entityType}).
${idMapping}
IMPORTANT : Si l'ID de la page est fourni, utilise-le.`
      });
    }

    if (toolContext?.tavilyApiKey) {
      const entityName = sellsyData?.data?.company?.name || pageContext?.entityName || "";
      const entityCity = sellsyData?.data?.company?.address?.city || "";
      const entitySector = sellsyData?.data?.company?.sector || "";
      if (thinkingMode === "high" || this._needsWebSearch(userMessage)) {
        const entityInfo = [entityName, entityCity, entitySector].filter(Boolean).join(", ");
        plan.push({
          type: "web",
          instruction: `Recherche des informations web sur ${entityInfo || "le sujet demandé"}.
Objectif : ${userMessage}
IMPORTANT : Formule des requetes de recherche PRECISES. Utilise le nom exact de l'entreprise${entityCity ? ` + ville "${entityCity}"` : ""} pour eviter les homonymes. Ne concatene PAS le message utilisateur brut comme requete.`
        });
      }
    }

    return plan;
  }

  /**
   * Build explicit ID mapping from available context so the sub-agent
   * knows exactly which Sellsy object type each ID refers to.
   */
  _buildIdMapping(sellsyData, pageContext) {
    const lines = [];
    const entityType = pageContext?.type || "generic";
    const entityId = pageContext?.entityId || "";

    // Map the page entity ID to its correct type
    if (entityId) {
      const typeToParam = {
        company: "companyId",
        contact: "contactId",
        opportunity: "opportunityId",
        quote: "quoteId"
      };
      const param = typeToParam[entityType];
      if (param) {
        lines.push(`- ${param}: ${entityId}`);
      } else {
        // generic or unknown — give the sub-agent a clear strategy with EXISTING tools
        lines.push(`- ID de page: ${entityId} (type non determiné)`);
        lines.push(`  → Pour trouver le type, essaie dans cet ordre avec l'ID ${entityId} :`);
        lines.push(`    1. sellsy_get_company(company_id: ${entityId})`);
        lines.push(`    2. sellsy_get_contact(contact_id: ${entityId})`);
        lines.push(`    3. sellsy_get_opportunity(opportunity_id: ${entityId})`);
        lines.push(`  → Utilise le premier appel qui retourne des donnees valides.`);
      }
    }

    // Extract additional IDs from enriched sellsyData
    const data = sellsyData?.data;
    if (data) {
      if (data.company?.id && !(entityType === "company" && String(data.company.id) === String(entityId))) {
        lines.push(`- companyId: ${data.company.id} (${data.company.name || ""})`);
      }
      if (data.contact?.id && !(entityType === "contact" && String(data.contact.id) === String(entityId))) {
        lines.push(`- contactId: ${data.contact.id} (${data.contact.fullName || ""})`);
      }
      if (data.opportunity?.id && !(entityType === "opportunity" && String(data.opportunity.id) === String(entityId))) {
        lines.push(`- opportunityId: ${data.opportunity.id} (${data.opportunity.name || ""})`);
      }
      if (data.opportunity?.companyId && !lines.some(l => l.includes(`companyId: ${data.opportunity.companyId}`))) {
        lines.push(`- companyId: ${data.opportunity.companyId} (via opportunite)`);
      }
      if (data.opportunity?.contactId && !lines.some(l => l.includes(`contactId: ${data.opportunity.contactId}`))) {
        lines.push(`- contactId: ${data.opportunity.contactId} (via opportunite)`);
      }
    }

    return lines.length > 0
      ? `IDs disponibles dans le contexte :\n${lines.join("\n")}`
      : "Aucun ID specifique disponible — utilise sellsy_search_companies pour trouver l'entite.";
  }

  _needsWebSearch(message) {
    return /internet|web|recherche|site|linkedin|actualit|news|march|concurrent|tendance|url|http/i.test(message);
  }

  /**
   * Returns true for short conversational messages that don't need CRM sub-agents.
   * These are handled directly by the base-agent (which has ask_user available).
   */
  _isConversational(message) {
    const m = message.toLowerCase().trim();
    if (m.length < 60 && /^(bonjour|hello|salut|hi|hey|merci|ok|oui|non|d'accord|parfait|super|top|génial|g[eé]nial|ça marche|c'est bon|je comprends|je vois|compris|entendu|not[eé]|voil[aà]|bien|bonne|continue|vas-y|go|allez)/.test(m)) {
      return true;
    }
    return false;
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
    const entityName = sellsyData?.data?.company?.name || sellsyData?.data?.opportunity?.name || pageContext?.entityName || "";
    yield {
      type: "agent_thinking",
      agentId: this.agentId,
      content: `Analyse commerciale de la demande.${entityName ? ` Entité : ${entityName}.` : ""} Préparation de ${plan.length} sous-agent(s).`
    };

    // 2. Agent plan
    yield {
      type: "agent_plan",
      agentId: this.agentId,
      plan: plan.map((t) => ({ type: t.type, instruction: t.instruction }))
    };

    // 3. Build global context
    const contextBlock = this.buildContextBlock(sellsyData, pageContext);
    const pageContextBlock = this.buildPageContextBlock(pageContext);
    let globalContext = "";
    if (pageContextBlock) globalContext += `Page Sellsy:\n${pageContextBlock}\n`;
    if (contextBlock) globalContext += `\nDonnees CRM:\n${contextBlock}\n`;
    if (knowledgeContext) globalContext += `\nBase de connaissances:\n${knowledgeContext}\n`;

    // 4. Stream pipeline events in real-time (live queue pattern)
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
        content: "Synthèse des données collectées et formulation de la réponse finale..."
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

    // Build sourcesUsed in proper object format from sub-agent string sources
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

    const synthesisPrompt = `Tu es le Commercial Agent de Boatswain. Réponds directement à la demande comme un collègue expert.

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
- Longue (> 5 phrases) UNIQUEMENT si l'utilisateur demande explicitement un compte-rendu, un mail, un bilan ou "plus de détails".
- TON : collègue expert, direct, naturel — comme dans une conversation au bureau.
- ENGAGEMENT : termine souvent par une question courte ou une suggestion d'action pour garder l'échange vivant.
- N'utilise JAMAIS "D'après les données", "Les résultats montrent", "Suite à mes recherches".
- NE MENTIONNE JAMAIS les sous-agents, les recherches effectuées, les outils utilisés.
- Si des informations manquent, pose une question précise plutôt que de supposer.
- Format Markdown léger (gras, listes si > 3 items). Pas de titres sauf pour les documents.
- N'inclue JAMAIS de JSON ou format technique dans ta réponse.${userLanguage?.instruction ? `\n\n${userLanguage.instruction}` : ""}`;

    const messages = [
      ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: synthesisPrompt }
    ];

    const result = await this.provider.chat({
      systemPrompt: this.systemPrompt, messages, temperature: 0.7, maxTokens: 4096
    });

    // Strip any JSON blocks that may have leaked into the response
    const cleanContent = (result.content || "").replace(/```json[\s\S]*?```/g, "").replace(/```[\s\S]*?```/g, (match) => {
      // Keep code blocks that look like user-facing content (not system JSON)
      return match.includes('"sources"') || match.includes('"sub_agents"') ? "" : match;
    }).trim();

    console.log(`[Commercial] _synthesize input: ${userMessage.slice(0, 100)} | think: ${results.map(r => r.think?.slice(0, 50)).join("; ")} | output length: ${cleanContent.length}`);

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
