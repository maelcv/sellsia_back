import { BaseLLMProvider } from "./base.js";

export class MistralProvider extends BaseLLMProvider {
  constructor(config) {
    super(config);
    this.providerName = "mistral";
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel || "mistral-small-latest";
  }

  async chat({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048 }) {
    const finalModel = model || this.defaultModel;

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: "system", content: systemPrompt });
    }
    apiMessages.push(...messages);

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: finalModel,
        messages: apiMessages,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Mistral API error ${response.status}: ${err.message || "Unknown error"}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content || "",
      tokensInput: data.usage?.prompt_tokens || 0,
      tokensOutput: data.usage?.completion_tokens || 0,
      model: finalModel,
      provider: this.providerName
    };
  }

  async chatWithTools({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048, tools }) {
    const finalModel = model || this.defaultModel;

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: "system", content: systemPrompt });
    }
    apiMessages.push(...messages);

    const body = {
      model: finalModel,
      messages: apiMessages,
      temperature,
      max_tokens: maxTokens
    };

    // Mistral uses OpenAI-compatible tool format
    if (tools?.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Mistral API error ${response.status}: ${err.message || "Unknown error"}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    const toolCalls = choice?.message?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments
    })) || null;

    return {
      content: choice?.message?.content || "",
      toolCalls,
      tokensInput: data.usage?.prompt_tokens || 0,
      tokensOutput: data.usage?.completion_tokens || 0,
      model: finalModel,
      provider: this.providerName,
      _rawMessage: choice?.message || null
    };
  }

  async *stream({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048 }) {
    const finalModel = model || this.defaultModel;

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: "system", content: systemPrompt });
    }
    apiMessages.push(...messages);

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: finalModel,
        messages: apiMessages,
        temperature,
        max_tokens: maxTokens,
        stream: true
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Mistral API error ${response.status}: ${err.message || "Unknown error"}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tokensInput = 0;
    let tokensOutput = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") {
          yield { chunk: "", done: true, tokensInput, tokensOutput };
          return;
        }

        try {
          const parsed = JSON.parse(payload);
          // Capture usage from final event (Mistral sends it in the last non-[DONE] chunk)
          if (parsed.usage) {
            tokensInput = parsed.usage.prompt_tokens || 0;
            tokensOutput = parsed.usage.completion_tokens || 0;
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            yield { chunk: delta, done: false };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    yield { chunk: "", done: true, tokensInput, tokensOutput };
  }

  /**
   * Chat with a Mistral AI Studio Agent
   * @param {string} agentId - The Mistral AI Studio agent ID
   * @param {Array} messages - Messages array in OpenAI format
   * @param {number} temperature - Temperature parameter (default: 0.7)
   * @param {number} maxTokens - Maximum tokens to generate (default: 2048)
   * @returns {Promise<Object>} Response with content and token usage
   */
  async vision({ base64, mediaType, prompt = "Décris cette image en détail." }) {
    const visionModel = this.config?.capabilityModels?.vision || this.config?.capabilities?.visionModel || "pixtral-12b-2409";
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: visionModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } }
          ]
        }],
        max_tokens: 1024
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Mistral vision error ${response.status}: ${err.message || "Unknown error"}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async chatWithAgent({ agentId, messages, temperature = 0.7, maxTokens = 2048 }) {
    if (!agentId) {
      throw new Error("Agent ID is required for chatWithAgent");
    }

    const response = await fetch("https://api.mistral.ai/v1/agents/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        agent_id: agentId,
        messages,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Mistral Agent API error ${response.status}: ${err.message || "Unknown error"}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content || "",
      tokensInput: data.usage?.prompt_tokens || 0,
      tokensOutput: data.usage?.completion_tokens || 0,
      agentId,
      provider: this.providerName,
      _rawMessage: choice?.message || null
    };
  }

  /**
   * Stream responses from a Mistral AI Studio Agent
   * @param {string} agentId - The Mistral AI Studio agent ID
   * @param {Array} messages - Messages array in OpenAI format
   * @param {number} temperature - Temperature parameter (default: 0.7)
   * @param {number} maxTokens - Maximum tokens to generate (default: 2048)
   * @yields {Object} Streaming chunks with { chunk, done }
   */
  async *streamWithAgent({ agentId, messages, temperature = 0.7, maxTokens = 2048 }) {
    if (!agentId) {
      throw new Error("Agent ID is required for streamWithAgent");
    }

    const response = await fetch("https://api.mistral.ai/v1/agents/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        agent_id: agentId,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Mistral Agent API error ${response.status}: ${err.message || "Unknown error"}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tokensInput = 0;
    let tokensOutput = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") {
          yield { chunk: "", done: true, tokensInput, tokensOutput };
          return;
        }

        try {
          const parsed = JSON.parse(payload);
          if (parsed.usage) {
            tokensInput = parsed.usage.prompt_tokens || 0;
            tokensOutput = parsed.usage.completion_tokens || 0;
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            yield { chunk: delta, done: false };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    yield { chunk: "", done: true, tokensInput, tokensOutput };
  }
}
