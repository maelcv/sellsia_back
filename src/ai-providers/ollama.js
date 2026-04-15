import { BaseLLMProvider } from "./base.js";

export class OllamaProvider extends BaseLLMProvider {
  constructor(config) {
    super(config);
    this.providerName = "ollama";
    this.baseUrl = (config.host || "http://localhost:11434").replace(/\/$/, "");
    this.defaultModel = config.defaultModel || "llama3.1";
  }

  async chat({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048 }) {
    const finalModel = model || this.defaultModel;

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: "system", content: systemPrompt });
    }
    apiMessages.push(...messages);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: finalModel,
        messages: apiMessages,
        stream: false,
        options: {
          temperature,
          num_predict: maxTokens
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}`);
    }

    const data = await response.json();

    return {
      content: data.message?.content || "",
      tokensInput: data.prompt_eval_count || 0,
      tokensOutput: data.eval_count || 0,
      model: finalModel,
      provider: this.providerName
    };
  }

  /**
   * chatWithTools for Ollama — NEVER sends tools in API request body.
   * Instead, injects tool descriptions into the system prompt and parses
   * structured JSON tool_calls from the model's text output.
   *
   * The model is instructed to output tool calls as:
   * ```tool_calls
   * [{"name": "tool_name", "arguments": {"param": "value"}}]
   * ```
   *
   * If no such block is found, we treat the response as a regular text answer.
   */
  async chatWithTools({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048, tools }) {
    const finalModel = model || this.defaultModel;

    // Build an enhanced system prompt with tool descriptions injected as text
    let enhancedSystemPrompt = systemPrompt || "";

    if (tools?.length > 0) {
      const toolDescriptions = this._buildToolPromptBlock(tools);
      enhancedSystemPrompt += toolDescriptions;
    }

    const apiMessages = [];
    if (enhancedSystemPrompt) {
      apiMessages.push({ role: "system", content: enhancedSystemPrompt });
    }
    apiMessages.push(...messages);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: finalModel,
        messages: apiMessages,
        stream: false,
        options: {
          temperature,
          num_predict: maxTokens
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}`);
    }

    const data = await response.json();
    const content = data.message?.content || "";

    // Try to parse tool_calls from the text output
    const { textContent, toolCalls } = this._parseToolCallsFromText(content);

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      tokensInput: data.prompt_eval_count || 0,
      tokensOutput: data.eval_count || 0,
      model: finalModel,
      provider: this.providerName
    };
  }

  /**
   * Build a text block describing available tools for injection into the system prompt.
   * Uses OpenAI-compatible tool format to extract name/description/parameters.
   */
  _buildToolPromptBlock(tools) {
    const toolLines = tools.map((t) => {
      // tools can be in OpenAI format {type:"function", function:{...}} or raw {name, description, parameters}
      const fn = t.function || t;
      const name = fn.name;
      const desc = fn.description || "";
      const params = fn.parameters || {};
      const props = params.properties || {};
      const required = params.required || [];

      const paramLines = Object.entries(props).map(([key, schema]) => {
        const req = required.includes(key) ? " (requis)" : " (optionnel)";
        return `      - ${key}: ${schema.type || "string"}${req} — ${schema.description || ""}`;
      });

      return `  - ${name}: ${desc}\n    Paramètres:\n${paramLines.join("\n") || "      (aucun)"}`;
    });

    return `

--- INSTRUCTIONS TOOL-CALLING ---
Tu as accès aux outils suivants. Si tu as besoin d'appeler un outil pour obtenir des données, réponds UNIQUEMENT avec un bloc tool_calls au format suivant (sans rien d'autre avant ou après) :

\`\`\`tool_calls
[{"name": "nom_outil", "arguments": {"param1": "valeur1"}}]
\`\`\`

Outils disponibles:
${toolLines.join("\n\n")}

RÈGLES IMPORTANTES:
- Si tu appelles un outil, ta réponse ENTIÈRE doit être UNIQUEMENT le bloc \`\`\`tool_calls. Ne mets RIEN d'autre.
- Tu peux appeler plusieurs outils à la fois en les mettant dans le même tableau JSON.
- Si tu n'as PAS besoin d'outil, réponds normalement en texte.
- Après avoir reçu les résultats d'outils, utilise-les pour formuler ta réponse finale.`;
  }

  /**
   * Parse tool calls from model text output.
   * Looks for ```tool_calls ... ``` blocks containing JSON.
   * Returns { textContent, toolCalls }.
   */
  _parseToolCallsFromText(content) {
    if (!content) return { textContent: "", toolCalls: [] };

    // Try multiple patterns to extract tool_calls block
    const patterns = [
      /```tool_calls\s*\n?([\s\S]*?)```/,
      /```json\s*\n?\s*(\[[\s\S]*?\])\s*```/,
      /```\s*\n?\s*(\[\s*\{[\s\S]*?"name"[\s\S]*?\}\s*\])\s*```/
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        try {
          const parsed = JSON.parse(match[1].trim());
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name) {
            const toolCalls = parsed.map((tc, idx) => ({
              id: `ollama-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
              name: tc.name,
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {})
            }));

            // Text content is everything outside the tool_calls block
            const textContent = content.replace(match[0], "").trim();

            return { textContent, toolCalls };
          }
        } catch {
          // JSON parse failed, try next pattern
        }
      }
    }

    // Also try to match raw JSON array at the start/end of content (no code fence)
    const rawJsonMatch = content.match(/^\s*(\[\s*\{[\s\S]*?"name"\s*:[\s\S]*?\}\s*\])\s*$/);
    if (rawJsonMatch) {
      try {
        const parsed = JSON.parse(rawJsonMatch[1]);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name) {
          const toolCalls = parsed.map((tc, idx) => ({
            id: `ollama-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
            name: tc.name,
            arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {})
          }));
          return { textContent: "", toolCalls };
        }
      } catch {
        // Not valid JSON
      }
    }

    // No tool calls found — return content as-is
    return { textContent: content, toolCalls: [] };
  }

  async *stream({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048 }) {
    const finalModel = model || this.defaultModel;

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: "system", content: systemPrompt });
    }
    apiMessages.push(...messages);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: finalModel,
        messages: apiMessages,
        stream: true,
        options: {
          temperature,
          num_predict: maxTokens
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.done) {
            yield { chunk: "", done: true };
            return;
          }
          if (parsed.message?.content) {
            yield { chunk: parsed.message.content, done: false };
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    yield { chunk: "", done: true };
  }
}
