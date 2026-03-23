/**
 * Base Sub-Agent — Classe de base pour les sous-agents spécialisés.
 * Chaque sous-agent a un domaine restreint (fichiers, Sellsy, web) et retourne
 * un résultat JSON standardisé : { demande, contexte, think, output, sources }
 */

import { executeTool, toOpenAITools, toAnthropicTools, toMistralTools } from "../mcp/tools.js";

const DEFAULT_MAX_TOKENS = 4096;

export class BaseSubAgent {
  /**
   * @param {Object} opts
   * @param {string} opts.type - 'file' | 'sellsy' | 'web'
   * @param {Object} opts.provider - LLM provider instance
   * @param {Array} opts.tools - Restricted tool set for this sub-agent
   * @param {string} opts.systemPrompt - Focused system prompt
   */
  constructor({ type, provider, tools, systemPrompt }) {
    this.type = type;
    this.provider = provider;
    this.tools = tools || [];
    this.systemPrompt = systemPrompt;
  }

  /**
   * Format tools for the current provider.
   */
  _formatToolsForProvider(tools) {
    if (!tools?.length) return null;
    const providerName = this.provider.providerName;
    if (providerName === "anthropic") return toAnthropicTools(tools);
    if (providerName === "mistral") return toMistralTools(tools);
    return toOpenAITools(tools);
  }

  /**
   * Build tool result messages based on provider type.
   */
  _buildToolResultMessages(providerName, result, toolResults) {
    if (providerName === "anthropic") {
      const messages = [];
      messages.push({ role: "assistant", content: result._rawContent || [] });
      const toolResultBlocks = toolResults.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolCallId,
        content: typeof r.output === "string" ? r.output : JSON.stringify(r.output)
      }));
      messages.push({ role: "user", content: toolResultBlocks });
      return messages;
    }

    if (providerName === "ollama") {
      const messages = [];
      messages.push({ role: "assistant", content: result.content || "" });
      const resultLines = toolResults.map((r) => {
        const output = typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2);
        const truncated = output.length > 4000 ? output.slice(0, 4000) + "\n... (tronque)" : output;
        return `### Resultat:\n${truncated}`;
      });
      messages.push({
        role: "user",
        content: `Voici les donnees collectees :\n\n${resultLines.join("\n\n")}\n\nUtilise ces donnees pour formuler ta reponse. Reponds en JSON avec les champs: think, output, sources.`
      });
      return messages;
    }

    // OpenAI, Mistral, OpenRouter, LM Studio
    const messages = [];
    messages.push({
      role: "assistant",
      content: result._rawMessage?.content || result.content || null,
      tool_calls: result._rawMessage?.tool_calls || result.toolCalls?.map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc.arguments }
      })) || []
    });
    for (const r of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: r.toolCallId,
        content: typeof r.output === "string" ? r.output : JSON.stringify(r.output)
      });
    }
    return messages;
  }

  /**
   * Execute the sub-agent: tool-calling loop then structured JSON response.
   *
   * @param {Object} params
   * @param {string} params.demande - What the main agent is asking
   * @param {string} params.contexte - Current accumulated context
   * @param {Object} params.toolContext - { sellsyClient, tavilyApiKey, uploadedFiles }
   * @param {string} params.thinkingMode - 'low' | 'high'
   * @param {Function} [params.onEvent] - Optional callback for streaming events
   * @returns {Promise<{ demande, contexte, think, output, sources, tokensInput, tokensOutput }>}
   */
  async execute({ demande, contexte = "", toolContext = {}, thinkingMode = "low", onEvent = null }) {
    const maxIterations = thinkingMode === "high" ? 5 : 2;
    const providerName = this.provider.providerName;

    // Build explicit tool list for the system prompt
    const toolNamesList = this.tools.map((t) => `- ${t.name}: ${t.description || ""}`).join("\n");

    // Build system prompt with structured output instructions
    const fullSystemPrompt = `${this.systemPrompt}

--- CONTEXTE ACTUEL ---
${contexte || "Aucun contexte disponible."}

--- OUTILS STRICTEMENT DISPONIBLES ---
Tu peux UNIQUEMENT utiliser les outils suivants. N'invente JAMAIS un nom d'outil qui n'est pas dans cette liste.
${toolNamesList || "Aucun outil disponible."}

REGLE ABSOLUE : Si un outil n'apparait PAS dans la liste ci-dessus, il N'EXISTE PAS. Ne tente jamais d'appeler un outil absent de cette liste (ex: sellsy_get_page_entity, determine_type, etc. n'existent PAS).

--- REGLES D'UTILISATION DES IDs ---
- Les IDs Sellsy sont TOUJOURS des entiers numeriques (ex: 92, 85, 107)
- JAMAIS utiliser un nom de parametre comme valeur (ex: "contactId" n'est PAS un ID valide, 107 en est un)
- Si le type d'entite est inconnu, essaie d'abord sellsy_get_company(company_id), puis sellsy_get_contact(contact_id), puis sellsy_get_opportunity(opportunity_id) avec le meme ID numerique
- Extrais l'ID NUMERIQUE du contexte, pas le label du champ

--- FORMAT DE REPONSE ---
Apres avoir collecte toutes les donnees necessaires via les outils, tu DOIS repondre avec un JSON valide :
\`\`\`json
{
  "think": "ton raisonnement sur la demande et les donnees collectees",
  "output": "le resultat pertinent a retourner (texte structure)",
  "sources": ["source1", "source2"]
}
\`\`\`
Les sources doivent etre des references precises (URLs, IDs Sellsy, noms de fichiers).`;

    const formattedTools = this._formatToolsForProvider(this.tools);
    const messages = [{ role: "user", content: demande }];

    let totalTokensInput = 0;
    let totalTokensOutput = 0;
    const allSources = [];

    // Tool-calling loop
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const chatParams = {
        systemPrompt: fullSystemPrompt,
        messages,
        temperature: 0.5,
        maxTokens: DEFAULT_MAX_TOKENS
      };

      let result;
      if (formattedTools?.length > 0) {
        chatParams.tools = formattedTools;
        result = await this.provider.chatWithTools(chatParams);
      } else {
        const chatResult = await this.provider.chat(chatParams);
        result = { ...chatResult, toolCalls: null };
      }

      totalTokensInput += result.tokensInput || 0;
      totalTokensOutput += result.tokensOutput || 0;

      // No tool calls — parse the structured response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        const parsed = this._parseStructuredResponse(result.content, demande, contexte);
        parsed.tokensInput = totalTokensInput;
        parsed.tokensOutput = totalTokensOutput;
        parsed.sources = [...new Set([...allSources, ...(parsed.sources || [])])];

        // Emit thinking summary and log
        if (onEvent && parsed.think) {
          onEvent({ type: "sub_agent_thinking", subAgentType: this.type, content: parsed.think });
        }
        console.log(`[SubAgent:${this.type}] think: ${String(parsed.think || "").slice(0, 200)} | output: ${String(parsed.output || "").slice(0, 200)}`);

        return parsed;
      }

      // Execute tool calls
      const toolResults = [];
      for (const toolCall of result.toolCalls) {
        let parsedArgs;
        try {
          parsedArgs = typeof toolCall.arguments === "string"
            ? JSON.parse(toolCall.arguments) : toolCall.arguments;
        } catch { parsedArgs = {}; }

        const toolOperation = this._detectToolOperation(toolCall.name, parsedArgs);
        if (onEvent) {
          onEvent({
            type: "tool_call",
            subAgentType: this.type,
            toolName: toolCall.name,
            toolArgs: parsedArgs,
            operation: toolOperation,
            iteration,
            entityType: parsedArgs?.company_id ? "company" : parsedArgs?.opportunity_id ? "opportunity" : parsedArgs?.contact_id ? "contact" : parsedArgs?.quote_id ? "quote" : null
          });
        }

        console.log(`[SubAgent:${this.type}] Tool call: ${toolCall.name} | input: ${JSON.stringify(parsedArgs || {}).slice(0, 200)}`);
        const output = await executeTool(toolCall.name, parsedArgs, toolContext);

        toolResults.push({ toolCallId: toolCall.id, name: toolCall.name, output });

        // Collect sources
        this._collectSource(toolCall.name, parsedArgs, output, allSources);

        if (onEvent) {
          const outputStr = typeof output === "string" ? output : JSON.stringify(output);
          const resultPreview = outputStr?.slice(0, 500) || null;
          onEvent({
            type: "tool_result",
            subAgentType: this.type,
            toolName: toolCall.name,
            success: !output?.error,
            error: output?.error || null,
            resultPreview,
            iteration
          });
        }
      }

      // Inject results back
      const turnMessages = this._buildToolResultMessages(providerName, result, toolResults);
      messages.push(...turnMessages);
    }

    // Max iterations — force a final answer without tools
    console.log(`[SubAgent:${this.type}] Max iterations reached, forcing final answer`);
    const finalResult = await this.provider.chat({
      systemPrompt: fullSystemPrompt,
      messages,
      temperature: 0.5,
      maxTokens: DEFAULT_MAX_TOKENS
    });
    totalTokensInput += finalResult.tokensInput || 0;
    totalTokensOutput += finalResult.tokensOutput || 0;

    const parsed = this._parseStructuredResponse(finalResult.content, demande, contexte);
    parsed.tokensInput = totalTokensInput;
    parsed.tokensOutput = totalTokensOutput;
    parsed.sources = [...new Set([...allSources, ...(parsed.sources || [])])];
    return parsed;
  }

  /**
   * Parse the structured JSON response from the sub-agent.
   */
  _parseStructuredResponse(content, demande, contexte) {
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          demande,
          contexte: parsed.contexte || contexte,
          think: typeof parsed.think === "string" ? parsed.think : String(parsed.think || ""),
          output: typeof parsed.output === "string" ? parsed.output : (parsed.output != null ? JSON.stringify(parsed.output) : ""),
          sources: Array.isArray(parsed.sources) ? parsed.sources : []
        };
      }
    } catch { /* fallback below */ }

    // Fallback: use raw content as output
    return {
      demande,
      contexte,
      think: "",
      output: content || "",
      sources: []
    };
  }

  /**
   * Detect the operation type from a tool name for animation purposes.
   */
  _detectToolOperation(toolName, args) {
    if (toolName === "web_search") return "search";
    if (toolName === "web_scrape") return "scrape";
    if (toolName.startsWith("parse_")) return "read";
    if (toolName === "sellsy_create_note") return "create";
    if (toolName === "sellsy_update_opportunity" || toolName === "sellsy_update_company") return "update";
    if (toolName.startsWith("sellsy_")) return "read";
    return "read";
  }

  /**
   * Collect source references from tool execution.
   */
  _collectSource(toolName, args, output, sources) {
    if (toolName === "web_search" && Array.isArray(output?.results)) {
      for (const r of output.results) {
        if (r?.url) sources.push(r.url);
      }
    }
    if (toolName === "web_scrape" && Array.isArray(output?.results)) {
      for (const r of output.results) {
        if (r?.url) sources.push(r.url);
      }
    }
    if (toolName.startsWith("sellsy_")) {
      const id = args.company_id || args.contact_id || args.opportunity_id || args.quote_id || args.entity_id || "";
      if (id) sources.push(`sellsy:${toolName.replace("sellsy_", "")}#${id}`);
    }
    if (toolName.startsWith("parse_")) {
      const filename = output?.filename || `file_${args.file_index}`;
      sources.push(`file:${filename}`);
    }
  }
}
