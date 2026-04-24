import { BaseLLMProvider } from "./base.js";

export class AnthropicProvider extends BaseLLMProvider {
  constructor(config) {
    super(config);
    this.providerName = "anthropic";
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel || "claude-sonnet-4-20250514";
  }

  async chat({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048 }) {
    const finalModel = model || this.defaultModel;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: finalModel,
        max_tokens: maxTokens,
        temperature,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: messages.filter((m) => m.role !== "system")
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(
        `Anthropic API error ${response.status}: ${err.error?.message || "Unknown error"}`
      );
    }

    const data = await response.json();
    const textBlock = data.content?.find((b) => b.type === "text");

    return {
      content: textBlock?.text || "",
      tokensInput: data.usage?.input_tokens || 0,
      tokensOutput: data.usage?.output_tokens || 0,
      model: finalModel,
      provider: this.providerName
    };
  }

  async chatWithTools({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048, tools }) {
    const finalModel = model || this.defaultModel;

    const body = {
      model: finalModel,
      max_tokens: maxTokens,
      temperature,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: messages.filter((m) => m.role !== "system")
    };

    // Add tools if provided (Anthropic tool format)
    if (tools?.length > 0) {
      body.tools = tools;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(
        `Anthropic API error ${response.status}: ${err.error?.message || "Unknown error"}`
      );
    }

    const data = await response.json();

    // Extract text content
    const textBlock = data.content?.find((b) => b.type === "text");

    // Extract tool use blocks
    const toolUseBlocks = data.content?.filter((b) => b.type === "tool_use") || [];
    const toolCalls = toolUseBlocks.length > 0
      ? toolUseBlocks.map((tb) => ({
          id: tb.id,
          name: tb.name,
          arguments: JSON.stringify(tb.input)
        }))
      : null;

    return {
      content: textBlock?.text || "",
      toolCalls,
      tokensInput: data.usage?.input_tokens || 0,
      tokensOutput: data.usage?.output_tokens || 0,
      model: finalModel,
      provider: this.providerName,
      // Keep raw content for multi-turn tool-calling
      _rawContent: data.content || [],
      _stopReason: data.stop_reason
    };
  }

  async vision({ base64, mediaType, prompt = "Décris cette image en détail." }) {
    const visionModel = this.config?.capabilityModels?.vision || this.config?.capabilities?.visionModel || this.defaultModel;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: visionModel,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt }
          ]
        }]
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Anthropic vision error ${response.status}: ${err.error?.message || "Unknown error"}`);
    }
    const data = await response.json();
    return data.content?.find(b => b.type === "text")?.text || "";
  }

  async *stream({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048 }) {
    const finalModel = model || this.defaultModel;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: finalModel,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: messages.filter((m) => m.role !== "system")
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(
        `Anthropic API error ${response.status}: ${err.error?.message || "Unknown error"}`
      );
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
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            yield { chunk: parsed.delta.text, done: false };
          }
          if (parsed.type === "message_stop") {
            yield { chunk: "", done: true };
            return;
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    }

    yield { chunk: "", done: true };
  }
}
