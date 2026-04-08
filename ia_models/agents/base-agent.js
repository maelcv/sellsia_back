/**
 * Base Agent — Classe de base pour tous les agents spécialisés.
 * Gère l'appel au LLM avec le prompt système, le contexte et l'historique.
 * Supporte le tool-calling agentic loop : LLM → tools → LLM → ... → réponse finale.
 */

import { executeTool, toOpenAITools, toAnthropicTools, toMistralTools } from "../mcp/tools.js";

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Detect the dominant language of a user message.
 * Returns a language object: { code, name, instruction }
 * - code: ISO-ish short code ("fr", "en", "es", "de", "it", "pt")
 * - name: human-readable name
 * - instruction: explicit instruction in the target language to force LLM compliance
 *
 * Called ONCE by the orchestrator, then propagated to agents and sub-agents.
 */
export function detectUserLanguage(userMessage) {
  const msg = (userMessage || "").toLowerCase().trim();

  const languages = [
    { code: "fr", name: "Français",
      instruction: "IMPORTANT : L'utilisateur écrit en français. Tu DOIS répondre INTÉGRALEMENT en français. Ne réponds PAS en anglais, en allemand, ni dans aucune autre langue.",
      words: /\b(le|la|les|des|un|une|du|au|aux|ce|cette|ces|est|sont|dans|pour|avec|sur|par|qui|que|mais|pas|vous|nous|ils|elles|mon|ton|son|notre|votre|leur|mes|tes|ses|nos|vos|leurs|je|tu|il|elle|on|quel|quelle|quoi|comment|pourquoi|quand|fait|faire|fais|bien|tout|toute|tous|toutes|plus|moins|aussi|comme|entre|chez|encore|depuis|avant|après|autre|autres|même|très|trop|peu|beaucoup|ici|donc|alors|merci|bonjour|salut|oui|non|peut|peux|dois|doit|veux|veut|faut|avoir|être|aller|venir|dire|voir|savoir|pouvoir|vouloir|devoir|donner|prendre|mettre|parler|demander|chercher|trouver|entreprise|société|commercial|commerciaux|client|clients|performance|rapport|bilan|analyse|opportunité|pipeline|chiffre|affaire|affaires|vente|ventes|contrat|devis)\b/ },
    { code: "en", name: "English",
      instruction: "IMPORTANT: The user wrote in English. You MUST respond entirely in English. Do NOT respond in French or any other language.",
      words: /\b(the|what|is|are|how|can|this|that|my|your|please|help|about|from|with|have|does|could|would|should|will|which|where|when|who|why|their|there|here|give|tell|show|find|make|need|want|know|look|like|just|also|some|them|been|more|than|very|much|each|into|only|other|its|had|but|not|all|our|out|one|his|her|she|has|him|you|did|get|may|new|any|say|now|old|see|way|day|too|use|man|did|boy|own|most|sure|work|after|year|call|over|ask|try|few|let|put|keep|must|made|well|back|end|still|between|never|last|long|great|little|right|good|big|come|another|next|same|first|went|much|before|something|english|answer|respond|reply)\b/ },
    { code: "es", name: "Español",
      instruction: "IMPORTANTE: El usuario escribió en español. DEBES responder completamente en español. NO respondas en francés ni en otro idioma.",
      words: /\b(el|la|los|las|que|por|para|con|una|del|este|esta|como|más|pero|sus|fue|son|está|hay|ser|tiene|todo|desde|puede|entre|también|sobre|hasta|cada|otro|donde|cuando|cual|quien|muy|bien|hace|algo|mismo|después|antes|sin|porque|todos|durante|siempre|mejor|mucho|ahora|hola|gracias|bueno|nombre|quiero|necesito|puedo|dime|buscar)\b/ },
    { code: "de", name: "Deutsch",
      instruction: "WICHTIG: Der Benutzer schrieb auf Deutsch. Du MUSST vollständig auf Deutsch antworten. Antworte NICHT auf Französisch oder einer anderen Sprache.",
      words: /\b(der|die|das|und|ist|von|mit|auf|für|den|ein|eine|dem|des|sich|nicht|auch|als|noch|wie|oder|was|nach|bei|aus|zum|zur|über|unter|bis|durch|aber|haben|kann|wird|sind|war|mehr|nur|wenn|dann|weil|schon|sehr|hier|dort|mein|dein|sein|ihr|wir|alle|kein|muss|soll|habe|geben|zeigen|finden|suchen|brauchen)\b/ },
    { code: "it", name: "Italiano",
      instruction: "IMPORTANTE: L'utente ha scritto in italiano. DEVI rispondere completamente in italiano. NON rispondere in francese o in un'altra lingua.",
      words: /\b(il|lo|la|le|gli|che|per|con|una|del|questo|questa|come|più|sono|dalla|anche|sua|suo|tra|ogni|dove|quando|quale|molto|bene|fare|cosa|stesso|dopo|prima|senza|perché|tutti|durante|sempre|meglio|adesso|ciao|grazie|buono|nome|voglio|posso|dimmi|cercare)\b/ },
    { code: "pt", name: "Português",
      instruction: "IMPORTANTE: O usuário escreveu em português. Você DEVE responder completamente em português. NÃO responda em francês ou qualquer outro idioma.",
      words: /\b(o|a|os|as|que|por|para|com|uma|dos|este|esta|como|mais|são|tem|também|sobre|cada|outro|onde|quando|qual|quem|muito|bem|fazer|algo|mesmo|depois|antes|sem|porque|todos|durante|sempre|melhor|agora|olá|obrigado|bom|nome|quero|preciso|posso|diga|buscar|você|não|sim|isso|está)\b/ },
  ];

  const frenchDefault = { code: "fr", name: "Français", instruction: "IMPORTANT : L'utilisateur écrit en français. Tu DOIS répondre INTÉGRALEMENT en français. Ne réponds PAS en anglais, en allemand, ni dans aucune autre langue." };
  if (!msg) return frenchDefault;

  let bestLang = null;
  let bestCount = 0;
  for (const lang of languages) {
    const matches = msg.match(lang.words);
    const count = matches ? matches.length : 0;
    if (count > bestCount) {
      bestCount = count;
      bestLang = lang;
    }
  }

  // Need enough signal — at least 2 keyword matches, or 1 for short messages (<=5 words)
  const wordCount = msg.split(/\s+/).length;
  if (bestLang && bestCount >= 2) return bestLang;
  if (bestLang && bestCount >= 1 && wordCount <= 5) return bestLang;

  // Default: French
  return frenchDefault;
}

export class BaseAgent {
  constructor({ agentId, provider, systemPrompt }) {
    this.agentId = agentId;
    this.provider = provider;
    this.systemPrompt = systemPrompt;
  }

  /**
   * Construit le contexte enrichi à injecter dans le prompt.
   * Surchargé par chaque agent spécialisé.
   * @param {Object} sellsyData - Données CRM récupérées
   * @param {Object} pageContext - Contexte de la page Sellsy
   * @returns {string}
   */
  buildContextBlock(sellsyData, pageContext) {
    if (!sellsyData?.data) {
      return pageContext?.type
        ? `Page Sellsy : ${pageContext.type} (pas de données CRM disponibles)`
        : "Aucun contexte Sellsy détecté.";
    }

    return `Données CRM :\n${JSON.stringify(sellsyData.data, null, 2)}`;
  }

  buildPageContextBlock(pageContext) {
    if (!pageContext || typeof pageContext !== "object") return "";

    const lines = [];
    if (pageContext.type) lines.push(`- Type page: ${pageContext.type}`);
    if (pageContext.entityId) lines.push(`- ID entité: ${pageContext.entityId}`);
    if (pageContext.entityName) lines.push(`- Nom entité: ${pageContext.entityName}`);
    if (pageContext.breadcrumbs) lines.push(`- Fil d'ariane: ${pageContext.breadcrumbs}`);
    if (pageContext.title) lines.push(`- Titre: ${pageContext.title}`);
    if (pageContext.pathname) lines.push(`- Pathname: ${pageContext.pathname}`);
    if (pageContext.url) lines.push(`- URL: ${pageContext.url}`);
    if (pageContext.sellsyUser) lines.push(`- Utilisateur Sellsy: ${pageContext.sellsyUser}`);
    if (pageContext.sellsyUserEmail) lines.push(`- Email Sellsy: ${pageContext.sellsyUserEmail}`);

    return lines.join("\n");
  }

  /**
   * Build the full system prompt from base + context blocks.
   */
  _buildFullSystemPrompt({ sellsyData, pageContext, knowledgeContext, tools, thinkingMode = "low", forceWebSearch = false, activeSkillBlock = "", userLanguage = null }) {
    const contextBlock = this.buildContextBlock(sellsyData, pageContext);
    const pageContextBlock = this.buildPageContextBlock(pageContext);

    const now = new Date();
    const currentDateStr = now.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const currentTimeStr = now.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
    const currentDateISO = now.toISOString();

    let fullSystemPrompt = this.systemPrompt + `\n\n--- DATE ET HEURE ACTUELLES ---\nAujourd'hui : ${currentDateStr}, ${currentTimeStr} (heure de Paris)\nDate UTC ISO : ${currentDateISO}\nIMPORTANT : Utilise TOUJOURS cette date comme référence pour planifier des rappels, des événements ou estimer des délais. Ne génère JAMAIS de dates dans le passé.`;
    if (pageContextBlock) {
      fullSystemPrompt += `\n\n--- CONTEXTE PAGE SELLSY ---\n${pageContextBlock}\n\nIMPORTANT : Quand l'utilisateur mentionne "la société", "l'entreprise", "la boite", "le client", "le compte", "l'opportunité" ou tout synonyme sans autre précision, il fait TOUJOURS référence à l'entité affichée sur cette page Sellsy — jamais à Sellsy lui-même.`;
    }
    if (contextBlock) {
      fullSystemPrompt += `\n\n--- CONTEXTE CRM ---\n${contextBlock}`;
    }
    if (knowledgeContext) {
      fullSystemPrompt += `\n\n--- BASE DE CONNAISSANCES ---\n${knowledgeContext}`;
    }

    // If tools are available, add instructions for the agent
    // Skip for Ollama — its chatWithTools() injects detailed tool-calling instructions
    // directly into the prompt with structured JSON format instructions.
    if (tools?.length > 0 && this.provider.providerName !== "ollama") {
      const toolNames = tools.map((t) => t.name).join(", ");
      fullSystemPrompt += `\n\n--- OUTILS DISPONIBLES ---
Tu as accès aux outils suivants: ${toolNames}.
Utilise-les quand tu as besoin de données supplémentaires pour répondre précisément.

OUTILS D'INTERACTION :
- ask_user : demande des précisions à l'utilisateur avec suggestions de réponse. Utilise-le en début de traitement si la demande est trop vague. Ne l'utilise pas si le contexte CRM suffit.
- navigate_to : redirige l'utilisateur vers une entité Sellsy (société, opportunité, contact, devis). Utilise-le quand l'utilisateur demande "montre-moi", "ouvre", "va sur", "redirige vers" une entité.

OUTILS DE MODIFICATION SELLSY (ask_user, update, note) :
- sellsy_update_opportunity / sellsy_update_company : RÈGLE ABSOLUE : appelle TOUJOURS ces outils sans confirmed=true en premier pour obtenir un récapitulatif. Présente le récap à l'utilisateur. N'appelle avec confirmed=true QUE si l'utilisateur confirme explicitement.
- sellsy_create_note : crée une note sur une entité, pas de confirmation requise.

OUTILS DE DONNÉES :
- Pour les recherches web (informations entreprise, actualités, concurrents) : utilise web_search.
- Pour lire le contenu complet d'une page web spécifique : utilise web_scrape.
- Pour accéder aux données CRM non encore chargées : utilise les outils sellsy_get_*.
- Pour traiter des fichiers uploadés : utilise parse_pdf, parse_csv, parse_excel, parse_word.

RÈGLES CRITIQUES POUR LA RECHERCHE WEB :
0. ENRICHISSEMENT CRM EN PRIORITÉ : Avant toute recherche web, consulte les données du CONTEXTE CRM ci-dessus. Extrais le nom exact de l'entité, sa ville, son pays et son secteur d'activité. Ces informations sont indispensables pour formuler une requête précise et éviter les homonymes. Ne lance une recherche web qu'après avoir identifié ces éléments.
1. Requête précise : pour une entreprise, inclus TOUJOURS son nom exact + ville/pays extraits du CRM (ex: "Kiliogene Bordeaux" et non "Kiliogene" seul). Si la ville n'est pas dans le CRM, utilise d'autres identifiants (secteur, SIRET, site officiel).
2. Vérification des résultats : après web_search, lis les titres et extraits de chaque résultat. Si un résultat semble concerner une autre entreprise (nom similaire mais ville ou secteur différent), ignore-le.
3. Scraping ciblé : n'appelle web_scrape QUE sur des URLs dont le titre ou le domaine indique clairement qu'elles correspondent à l'entité recherchée. En cas de doute, abstiens-toi de scraper.
4. En cas de mauvais résultats : reformule la requête avec plus de détails (secteur, SIRET, site officiel, etc.) plutôt que de scraper des pages non pertinentes.
N'hésite PAS à appeler plusieurs outils si nécessaire. Les résultats seront injectés automatiquement.`;
    }

    const hasWebSearchTool = Array.isArray(tools) && tools.some((tool) => tool.name === "web_search");

    // ── Web search instructions ──
    if (forceWebSearch && hasWebSearchTool) {
      // User explicitly toggled Web Search ON — enforce regardless of mode
      fullSystemPrompt += `\n\n--- WEB SEARCH OBLIGATOIRE ---
L'utilisateur a active la recherche web. Tu DOIS appeler l'outil web_search au moins une fois, independamment du mode. Cette regle est absolue : sans appel a web_search, ta reponse sera incomplete. Effectue au minimum une recherche web pertinente sur l'entite ou le sujet en question.`;
    } else if (thinkingMode === "high" && hasWebSearchTool) {
      // High mode without explicit toggle: encourage web search for relevant external information
      fullSystemPrompt += `\n\n--- WEB SEARCH DISPONIBLE ---
Mode avance : la recherche web est disponible et encouragee. Utilise web_search quand cela apporte de la valeur (informations recentes, verification de faits, donnees marche/concurrence, enrichissement contextuel). N'effectue PAS de recherche web si la demande est purement interne au CRM ou si tu as deja toutes les informations necessaires.`;
    }

    // ── Thinking mode ──
    if (thinkingMode === "high") {
      fullSystemPrompt += `\n\n--- MODE REFLEXION AVANCEE ---
Mode HIGH actif. Processus obligatoire en 4 etapes :
1. PLANIFICATION : Avant d'utiliser le moindre outil, identifie mentalement toutes les informations dont tu as besoin et dans quel ordre les obtenir.
2. COLLECTE METHODIQUE : Commence TOUJOURS par les donnees CRM disponibles (section CONTEXTE CRM). Extrais le nom exact, la ville, le secteur de l'entite. N'effectue une recherche web qu'APRES avoir exploite les donnees CRM, et uniquement si elles sont insuffisantes.
3. VERIFICATION : Apres chaque recherche web, verifie que les resultats correspondent bien a l'entite cible (meme nom, meme ville/secteur que dans le CRM). Croise plusieurs sources independantes. Si un resultat semble hors-sujet, ignore-le et reformule la requete avec les donnees CRM.
4. SYNTHESE : Produis une reponse complete, structuree et de haute qualite qui integre toutes les informations collectees de maniere coherente.
Ne te precipite PAS sur les outils sans avoir reflechi a ce que tu cherches. La precision prime sur la rapidite.`;
    } else {
      fullSystemPrompt += `\n\n--- MODE DIRECT ---
Mode LOW active. Reponds de maniere efficace et directe. Va droit au but. Reflexion limitee. N'utilise les outils que si strictement necessaire pour repondre a la demande.`;
    }

    // ── Active Skill injection ──
    if (activeSkillBlock) {
      fullSystemPrompt += activeSkillBlock;
    }

    // ── Output quality rules (CRITICAL — always applied) ──
    fullSystemPrompt += `\n\n--- REGLES DE SORTIE (OBLIGATOIRE) ---
Ta reponse est affichee DIRECTEMENT a l'utilisateur final. Elle doit etre professionnelle et propre.

STRICTEMENT INTERDIT dans ta reponse :
- Parametres d'outils ou d'API (query, max_results, search_depth, file_index, etc.)
- Noms d'outils internes (web_search, web_scrape, sellsy_*, parse_*, etc.)
- Narration du processus de recherche ("Je vais effectuer une recherche...", "Resultat web 1:...", "Voici ce que j'ai trouve...")
- Blocs techniques type "[Web Search]", "[Tool Call]", "tool_calls"
- Resultats de recherche bruts, snippets ou URLs non traites
- Description des etapes internes, du raisonnement technique ou des appels API
- Etapes intermediaires ("Prochaine etape...", "Maintenant je vais...")

LONGUEUR DE REPONSE — REGLE ABSOLUE :
- Par defaut : 1 a 3 phrases maximum. Pas plus.
- Exception toleree : jusqu'a 5 phrases si la complexite le justifie vraiment.
- Reponse longue (> 5 phrases) UNIQUEMENT si l'utilisateur le demande explicitement ("explique tout", "detaille", "fais un rapport", "redige", "liste tout", "donne-moi plus").
- Favorise l'echange : pose une question ou propose la prochaine etape plutot que de tout livrer d'un coup.
- Une reponse longue non sollicitee est une erreur grave.

LANGUE — REGLE ABSOLUE :
- Tu DOIS repondre dans la MEME LANGUE que celle utilisee par l'utilisateur dans son dernier message.
- Si l'utilisateur ecrit en anglais, reponds en anglais. En espagnol, reponds en espagnol. En francais, reponds en francais. Etc.
- Detecte la langue du message utilisateur et adapte-toi automatiquement. Ne traduis pas, reponds directement dans sa langue.${userLanguage?.instruction ? `\n${userLanguage.instruction}` : ""}

OBLIGATOIRE :
- Reponds directement et professionnellement a la demande de l'utilisateur
- Integre les informations obtenues naturellement sans mentionner leur provenance technique
- Format Markdown leger : gras et listes courtes si pertinent. Titres uniquement pour les documents.
- Sois factuel, precis et actionnable
- Si tu cites des informations externes, integre-les naturellement dans le texte`;

    return fullSystemPrompt;
  }

  _pushUniqueSource(targetList, item, keyBuilder) {
    if (!item) return;
    const key = keyBuilder(item);
    if (!key) return;
    if (targetList.some((existing) => keyBuilder(existing) === key)) return;
    targetList.push(item);
  }

  _collectSourcesFromToolCall(toolCall, output, toolContext, sourcesUsed) {
    const name = toolCall?.name || "";
    const args = toolCall?.args || {};

    if (name === "web_search") {
      const results = Array.isArray(output?.results) ? output.results : [];
      for (const result of results) {
        this._pushUniqueSource(
          sourcesUsed.web,
          {
            url: result?.url || "",
            title: result?.title || result?.url || "Source web",
            snippet: result?.content || ""
          },
          (entry) => entry.url || entry.title
        );
      }
    }

    if (name === "web_scrape") {
      const results = Array.isArray(output?.results) ? output.results : [];
      for (const result of results) {
        this._pushUniqueSource(
          sourcesUsed.web,
          {
            url: result?.url || "",
            title: result?.url || "Page web scrapée",
            snippet: result?.rawContent?.slice(0, 200) || ""
          },
          (entry) => entry.url || entry.title
        );
      }
    }

    if (name.startsWith("sellsy_")) {
      const objectType = name.replace("sellsy_", "");
      const objectId =
        args.company_id ||
        args.contact_id ||
        args.opportunity_id ||
        args.quote_id ||
        args.entity_id ||
        args.pipeline_id ||
        "";

      this._pushUniqueSource(
        sourcesUsed.sellsy,
        {
          objectType,
          objectId: objectId ? String(objectId) : "",
          label: `${objectType}${objectId ? ` #${objectId}` : ""}`
        },
        (entry) => `${entry.objectType}:${entry.objectId}`
      );
    }

    if (name.startsWith("parse_")) {
      const fileIndex = Number.isInteger(args.file_index) ? args.file_index : null;
      const fallbackName = fileIndex != null
        ? toolContext?.uploadedFiles?.[fileIndex]?.originalname
        : "";
      const filename = output?.filename || fallbackName || "Fichier";

      this._pushUniqueSource(
        sourcesUsed.files,
        {
          filename,
          tool: name,
          fileIndex: fileIndex != null ? fileIndex : undefined
        },
        (entry) => `${entry.filename}:${entry.tool}`
      );
    }
  }

  _hasTool(tools, toolName) {
    return Array.isArray(tools) && tools.some((tool) => tool?.name === toolName);
  }

  _hasToolUsage(toolsUsed, toolName) {
    return Array.isArray(toolsUsed) && toolsUsed.some((usage) => usage?.name === toolName);
  }

  _buildForcedWebQuery(userMessage, pageContext) {
    const parts = [String(userMessage || "").trim()];
    // Only include the entity name — never CRM IDs or types (they make terrible web queries)
    if (pageContext?.entityName) parts.push(pageContext.entityName);
    return parts.filter(Boolean).join(" ").slice(0, 350);
  }

  _injectForcedWebResultMessage(messages, query, output) {
    const payload = typeof output === "string" ? output : JSON.stringify(output);
    const preview = payload.length > 8000 ? `${payload.slice(0, 8000)}\n... (tronque)` : payload;
    messages.push({
      role: "user",
      content: `Voici des informations web complementaires :\n${preview}\n\nIntegre ces informations naturellement dans ta reponse. Ne mentionne PAS qu'il s'agit d'une recherche automatique. Ne montre PAS les parametres de recherche. Reponds directement et professionnellement.`
    });
  }

  /**
   * Format tools for the current provider.
   */
  _formatToolsForProvider(tools) {
    if (!tools?.length) return null;

    const providerName = this.provider.providerName;

    if (providerName === "anthropic") {
      return toAnthropicTools(tools);
    }

    // Mistral requires strict schema validation — use dedicated sanitizer
    if (providerName === "mistral") {
      return toMistralTools(tools);
    }

    // OpenAI, OpenRouter, LM Studio all use OpenAI format
    // Ollama also accepts OpenAI format for compatible models
    return toOpenAITools(tools);
  }

  /**
   * Build messages for tool-call multi-turn for OpenAI-compatible providers.
   * After receiving tool_calls, we add the assistant message + tool results.
   */
  _buildToolResultMessages_OpenAI(rawMessage, toolResults) {
    const messages = [];

    // Build the assistant message that requested tools.
    // Mistral (and OpenAI) reject a message with content: null AND tool_calls: []
    // so we only include each field when it has a meaningful value.
    const assistantMsg = { role: "assistant" };
    const rawContent = rawMessage?.content || null;
    const rawToolCalls = rawMessage?.tool_calls?.length > 0 ? rawMessage.tool_calls : null;

    if (rawContent !== null) assistantMsg.content = rawContent;
    if (rawToolCalls !== null) assistantMsg.tool_calls = rawToolCalls;

    // Fallback: if neither field is present, set content to empty string so the
    // message is at least valid (shouldn't normally happen).
    if (!("content" in assistantMsg) && !("tool_calls" in assistantMsg)) {
      assistantMsg.content = "";
    }

    messages.push(assistantMsg);

    // Add tool results
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: typeof result.output === "string" ? result.output : JSON.stringify(result.output)
      });
    }

    return messages;
  }

  /**
   * Build messages for tool-call multi-turn for Anthropic.
   * Anthropic uses content blocks with tool_use and tool_result.
   */
  _buildToolResultMessages_Anthropic(rawContent, toolResults) {
    const messages = [];

    // Add the assistant message with its original content blocks
    messages.push({
      role: "assistant",
      content: rawContent || []
    });

    // Add tool results as a user message with tool_result blocks
    const toolResultBlocks = toolResults.map((r) => ({
      type: "tool_result",
      tool_use_id: r.toolCallId,
      content: typeof r.output === "string" ? r.output : JSON.stringify(r.output)
    }));

    messages.push({
      role: "user",
      content: toolResultBlocks
    });

    return messages;
  }

  /**
   * Build messages for tool-call multi-turn for Ollama.
   * Since Ollama doesn't use the OpenAI tool protocol, we use plain
   * assistant/user messages. The assistant message is the raw text output,
   * and the tool results are injected as a user message with clear formatting
   * so the model can use them to formulate its final answer.
   */
  _buildToolResultMessages_Ollama(assistantContent, toolResults) {
    const messages = [];

    // Add the assistant's raw response (which contained the tool_calls block)
    messages.push({
      role: "assistant",
      content: assistantContent || ""
    });

    // Build a clear text block with all tool results (using friendly labels, not internal tool names)
    const resultLines = toolResults.map((r) => {
      const output = typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2);
      // Truncate very large results to avoid blowing up the context
      const truncated = output.length > 4000 ? output.slice(0, 4000) + "\n... (tronqué)" : output;
      const label = r.name === "web_search" ? "Recherche web"
        : r.name === "web_scrape" ? "Contenu page web"
        : r.name?.startsWith("sellsy_") ? "Données CRM"
        : r.name?.startsWith("parse_") ? "Contenu fichier"
        : "Données";
      return `### ${label}:\n${truncated}`;
    });

    messages.push({
      role: "user",
      content: `Voici les donnees collectees :\n\n${resultLines.join("\n\n")}\n\nUtilise ces donnees pour formuler ta reponse finale. IMPORTANT : ne mentionne PAS les noms d'outils, les parametres de recherche, ni le processus de collecte dans ta reponse. Reponds directement et professionnellement a l'utilisateur.`
    });

    return messages;
  }

  /**
   * Exécute l'agent avec boucle agentique de tool-calling.
   *
   * Loop: LLM call → detect tool_calls → execute tools → inject results → LLM again
   * Continues until: no tool_calls, or max iterations reached.
   *
   * @param {Object} params
   * @param {string} params.userMessage
   * @param {Array} params.conversationHistory
   * @param {Object} params.sellsyData
   * @param {Object} params.pageContext
   * @param {Object} params.knowledgeContext
   * @param {Array} [params.tools] - Available tools from registry
   * @param {Object} [params.toolContext] - Context for tool execution { sellsyClient, tavilyApiKey, uploadedFiles }
   * @returns {Promise<{content: string, tokensInput: number, tokensOutput: number, model: string, provider: string, toolsUsed: Array}>}
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
    activeSkillBlock = "",
    userLanguage = null
  }) {
    const fullSystemPrompt = this._buildFullSystemPrompt({
      sellsyData,
      pageContext,
      knowledgeContext,
      tools,
      thinkingMode,
      forceWebSearch: Boolean(toolContext?.forceWebSearch),
      activeSkillBlock,
      userLanguage
    });
    const maxToolIterations = thinkingMode === "high" ? 8 : 3;
    // Force web search fallback when user explicitly toggled it ON, regardless of thinking mode.
    // In HIGH mode without explicit toggle, the agent decides autonomously.
    const shouldForceWebSearch = Boolean(toolContext?.forceWebSearch) && this._hasTool(tools, "web_search");
    let forcedWebFallbackUsed = false;

    const formattedTools = this._formatToolsForProvider(tools);

    // Build initial messages.
    // Empty assistant messages (from failed previous turns) cause Mistral 400.
    // Replace them with a placeholder so the conversation alternation stays valid.
    const messages = [
      ...conversationHistory.map((m) => ({
        role: m.role,
        content: m.role === "assistant" && !m.content?.trim()
          ? "(Réponse non disponible)"
          : (m.content || "")
      })),
      { role: "user", content: userMessage }
    ];

    let totalTokensInput = 0;
    let totalTokensOutput = 0;
    const toolsUsed = [];
    const sourcesUsed = { web: [], sellsy: [], files: [] };
    const providerName = this.provider.providerName;

    // ── Agentic tool-calling loop ──
    for (let iteration = 0; iteration < maxToolIterations; iteration++) {
      const chatParams = {
        systemPrompt: fullSystemPrompt,
        messages,
        temperature: 0.7,
        maxTokens: DEFAULT_MAX_TOKENS
      };

      let result;

      if (formattedTools?.length > 0) {
        chatParams.tools = formattedTools;
        result = await this.provider.chatWithTools(chatParams);
      } else {
        // No tools — regular chat
        const chatResult = await this.provider.chat(chatParams);
        result = { ...chatResult, toolCalls: null };
      }

      totalTokensInput += result.tokensInput || 0;
      totalTokensOutput += result.tokensOutput || 0;

      // If no tool calls, we're done — return the final content
      if (!result.toolCalls || result.toolCalls.length === 0) {
        if (shouldForceWebSearch && !forcedWebFallbackUsed && !this._hasToolUsage(toolsUsed, "web_search")) {
          const forcedQuery = this._buildForcedWebQuery(userMessage, pageContext);
          const forcedArgs = {
            query: forcedQuery || "actualites recentes et informations fiables",
            max_results: thinkingMode === "high" ? 10 : 6,
            search_depth: "advanced"
          };

          const forcedOutput = await executeTool("web_search", forcedArgs, toolContext || {});
          toolsUsed.push({
            name: "web_search",
            args: forcedArgs,
            iteration,
            success: !forcedOutput?.error,
            error: forcedOutput?.error || null,
            forced: true
          });
          this._collectSourcesFromToolCall(
            { name: "web_search", args: forcedArgs },
            forcedOutput,
            toolContext || {},
            sourcesUsed
          );

          if (result.content) {
            messages.push({ role: "assistant", content: result.content });
          }
          this._injectForcedWebResultMessage(messages, forcedArgs.query, forcedOutput);
          forcedWebFallbackUsed = true;
          continue;
        }

        return {
          content: result.content,
          tokensInput: totalTokensInput,
          tokensOutput: totalTokensOutput,
          model: result.model,
          provider: result.provider,
          toolsUsed,
          sourcesUsed
        };
      }

      // ── Execute each tool call ──
      const toolResults = [];

      for (const toolCall of result.toolCalls) {
        let parsedArgs;
        try {
          parsedArgs = typeof toolCall.arguments === "string"
            ? JSON.parse(toolCall.arguments)
            : toolCall.arguments;
        } catch {
          parsedArgs = {};
        }

        // Log sans exposer les arguments complets (peuvent contenir des données sensibles)
        console.log(`[Agent:${this.agentId}] Tool call: ${toolCall.name} (args keys: ${Object.keys(parsedArgs || {}).join(", ")})`);

        const output = await executeTool(toolCall.name, parsedArgs, toolContext || {});

        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          output
        });

        toolsUsed.push({
          name: toolCall.name,
          args: parsedArgs,
          iteration,
          success: !output?.error,
          error: output?.error || null
        });

        this._collectSourcesFromToolCall(
          { name: toolCall.name, args: parsedArgs },
          output,
          toolContext || {},
          sourcesUsed
        );
      }

      // ── Inject tool results back into messages ──
      if (providerName === "anthropic") {
        const turnMessages = this._buildToolResultMessages_Anthropic(
          result._rawContent,
          toolResults
        );
        messages.push(...turnMessages);
      } else if (providerName === "ollama") {
        // Ollama: tools were injected in prompt, not in API body.
        // We use plain user/assistant messages to convey tool results.
        const turnMessages = this._buildToolResultMessages_Ollama(result.content, toolResults);
        messages.push(...turnMessages);
      } else {
        // OpenAI, Mistral, OpenRouter, LM Studio
        const rawMessage = result._rawMessage || {
          role: "assistant",
          content: result.content,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments }
          }))
        };
        const turnMessages = this._buildToolResultMessages_OpenAI(rawMessage, toolResults);
        messages.push(...turnMessages);
      }

      // Continue loop — LLM will see tool results and either call more tools or produce final answer
    }

    // Max iterations reached — do a final call without tools to force an answer
    console.log(`[Agent:${this.agentId}] Max tool iterations (${maxToolIterations}) reached, forcing final answer`);

    const finalResult = await this.provider.chat({
      systemPrompt: fullSystemPrompt,
      messages,
      temperature: 0.7,
      maxTokens: DEFAULT_MAX_TOKENS
    });

    totalTokensInput += finalResult.tokensInput || 0;
    totalTokensOutput += finalResult.tokensOutput || 0;

    return {
      content: finalResult.content,
      tokensInput: totalTokensInput,
      tokensOutput: totalTokensOutput,
      model: finalResult.model,
      provider: finalResult.provider,
      toolsUsed,
      sourcesUsed
    };
  }

  /**
   * Version streaming de execute().
   *
   * Strategy: Run the agentic tool-calling loop (non-streaming) for tool calls,
   * then stream the final answer once no more tools are needed.
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
    activeSkillBlock = "",
    userLanguage = null
  }) {
    const fullSystemPrompt = this._buildFullSystemPrompt({
      sellsyData,
      pageContext,
      knowledgeContext,
      tools,
      thinkingMode,
      forceWebSearch: Boolean(toolContext?.forceWebSearch),
      activeSkillBlock,
      userLanguage
    });
    const maxToolIterations = thinkingMode === "high" ? 8 : 3;
    // Force web search fallback when user explicitly toggled it ON, regardless of thinking mode.
    const shouldForceWebSearch = Boolean(toolContext?.forceWebSearch) && this._hasTool(tools, "web_search");
    let forcedWebFallbackUsed = false;

    const formattedTools = this._formatToolsForProvider(tools);

    // Build initial messages — filter out invalid assistant messages (empty
    // content without tool_calls) that Mistral/OpenAI would reject.
    const messages = [
      ...conversationHistory
        .map((m) => ({ role: m.role, content: m.content || "" }))
        .filter((m) => m.role !== "assistant" || m.content.trim() !== ""),
      { role: "user", content: userMessage }
    ];

    const toolsUsed = [];
    const sourcesUsed = { web: [], sellsy: [], files: [] };

    // If no tools, stream directly
    if (!formattedTools?.length) {
      for await (const event of this.provider.stream({
        systemPrompt: fullSystemPrompt,
        messages,
        temperature: 0.7,
        maxTokens: DEFAULT_MAX_TOKENS
      })) {
        if (event.done) break;
        yield event;
      }
      yield { chunk: "", done: true, toolsUsed, sourcesUsed };
      return;
    }

    const providerName = this.provider.providerName;

    // ── Non-streaming tool-calling loop ──
    for (let iteration = 0; iteration < maxToolIterations; iteration++) {
      const result = await this.provider.chatWithTools({
        systemPrompt: fullSystemPrompt,
        messages,
        temperature: 0.7,
        maxTokens: DEFAULT_MAX_TOKENS,
        tools: formattedTools
      });

      // No tool calls — we have the final answer.
      // For providers that support real streaming, stream the final answer directly.
      // For Ollama (prompt-based tools), the content is already generated — yield it progressively.
      if (!result.toolCalls || result.toolCalls.length === 0) {
        if (shouldForceWebSearch && !forcedWebFallbackUsed && !this._hasToolUsage(toolsUsed, "web_search")) {
          const forcedQuery = this._buildForcedWebQuery(userMessage, pageContext);
          const forcedArgs = {
            query: forcedQuery || "actualites recentes et informations fiables",
            max_results: thinkingMode === "high" ? 10 : 6,
            search_depth: "advanced"
          };

          yield {
            type: "tool_call",
            toolName: "web_search",
            toolArgs: forcedArgs,
            iteration,
            forced: true
          };

          const forcedOutput = await executeTool("web_search", forcedArgs, toolContext || {});
          toolsUsed.push({
            name: "web_search",
            args: forcedArgs,
            iteration,
            success: !forcedOutput?.error,
            error: forcedOutput?.error || null,
            forced: true
          });
          this._collectSourcesFromToolCall(
            { name: "web_search", args: forcedArgs },
            forcedOutput,
            toolContext || {},
            sourcesUsed
          );

          yield {
            type: "tool_result",
            toolName: "web_search",
            success: !forcedOutput?.error,
            error: forcedOutput?.error || null,
            iteration,
            forced: true
          };

          if (result.content) {
            messages.push({ role: "assistant", content: result.content });
          }
          this._injectForcedWebResultMessage(messages, forcedArgs.query, forcedOutput);
          forcedWebFallbackUsed = true;
          continue;
        }

        const content = result.content || "";
        // Yield content in sentence-sized chunks. Word-by-word floods SSE buffers
        // and causes the client parser to drop events; sentence batches keep the
        // streaming feel while staying parseable.
        const sentences = content.split(/(?<=[.!?\n])\s+/);
        for (const sentence of sentences) {
          if (sentence) {
            yield { chunk: sentence + " ", done: false };
          }
        }
        yield { chunk: "", done: true, toolsUsed, sourcesUsed };
        return;
      }

      // Execute tool calls
      const toolResults = [];
      let hasAskedUser = false;

      for (const toolCall of result.toolCalls) {
        let parsedArgs;
        try {
          parsedArgs = typeof toolCall.arguments === "string"
            ? JSON.parse(toolCall.arguments)
            : toolCall.arguments;
        } catch {
          parsedArgs = {};
        }

        // Yield a metadata event so the consumer knows a tool is being called
        yield {
          type: "tool_call",
          toolName: toolCall.name,
          toolArgs: parsedArgs,
          iteration
        };

        console.log(`[Agent:${this.agentId}] Stream tool call: ${toolCall.name} (args keys: ${Object.keys(parsedArgs || {}).join(", ")})`);
        const output = await executeTool(toolCall.name, parsedArgs, toolContext || {});
        toolResults.push({ toolCallId: toolCall.id, name: toolCall.name, output });
        toolsUsed.push({ name: toolCall.name, args: parsedArgs, iteration });
        toolsUsed[toolsUsed.length - 1].success = !output?.error;
        toolsUsed[toolsUsed.length - 1].error = output?.error || null;
        this._collectSourcesFromToolCall(
          { name: toolCall.name, args: parsedArgs },
          output,
          toolContext || {},
          sourcesUsed
        );

        // Yield a metadata event with the tool result summary + data preview
        const outputPreview = (() => {
          try {
            const str = typeof output === "string" ? output : JSON.stringify(output, null, 2);
            return str.length > 3000 ? str.slice(0, 3000) + "\n... (truncated)" : str;
          } catch { return "[non-serializable]"; }
        })();

        yield {
          type: "tool_result",
          toolName: toolCall.name,
          success: !output?.error,
          error: output?.error || null,
          resultPreview: outputPreview,
          iteration
        };

        // ── Special tool response events ──
        if (toolCall.name === "ask_user" && output?.type === "ask_user_pending") {
          hasAskedUser = true;
          yield {
            type: "ask_user",
            question: output.question,
            suggestions: output.suggestions || [],
            context: output.context || null
          };
        }

        if (toolCall.name === "navigate_to" && output?.type === "navigate") {
          yield {
            type: "navigate",
            entity_type: output.entity_type,
            entity_id: output.entity_id,
            new_tab: Boolean(output.new_tab)
          };
        }
      }

      // Yield current accumulated sources after each tool round
      yield {
        type: "sources",
        toolsUsed: [...toolsUsed],
        sourcesUsed: { ...sourcesUsed }
      };

      // Inject tool results into message history
      if (providerName === "anthropic") {
        messages.push(...this._buildToolResultMessages_Anthropic(result._rawContent, toolResults));
      } else if (providerName === "ollama") {
        messages.push(...this._buildToolResultMessages_Ollama(result.content, toolResults));
      } else {
        const rawMessage = result._rawMessage || {
          role: "assistant",
          content: result.content,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments }
          }))
        };
        messages.push(...this._buildToolResultMessages_OpenAI(rawMessage, toolResults));
      }

      // ── Pause after ask_user: break the tool loop so the LLM generates
      // the question as its final answer, then the stream ends. The agent
      // resumes naturally on the user's next message. ──
      if (hasAskedUser) {
        break;
      }
    }

    // Max iterations — stream the last call without tools
    console.log(`[Agent:${this.agentId}] Stream: max tool iterations reached, streaming final answer`);

    for await (const event of this.provider.stream({
      systemPrompt: fullSystemPrompt,
      messages,
      temperature: 0.7,
      maxTokens: DEFAULT_MAX_TOKENS
    })) {
      if (event.done) break;
      yield event;
    }
    yield { chunk: "", done: true, toolsUsed, sourcesUsed };
  }
}
