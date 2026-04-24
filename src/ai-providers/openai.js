import { BaseLLMProvider } from "./base.js";

export class OpenAIProvider extends BaseLLMProvider {
  constructor(config) {
    super(config);
    this.providerName = "openai";
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.defaultModel = config.defaultModel || "gpt-4o-mini";
  }

  async chat({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048 }) {
    const finalModel = model || this.defaultModel;

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: "system", content: systemPrompt });
    }
    apiMessages.push(...messages);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
      throw new Error(`OpenAI API error ${response.status}: ${err.error?.message || "Unknown error"}`);
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

    // Add tools if provided (OpenAI function-calling format)
    if (tools?.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error ${response.status}: ${err.error?.message || "Unknown error"}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    // Extract tool calls if present
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
      // Keep raw message for multi-turn tool-calling
      _rawMessage: choice?.message || null
    };
  }

  async vision({ base64, mediaType, prompt = "Décris cette image en détail." }) {
    const visionModel = this.config?.capabilityModels?.vision || this.config?.capabilities?.visionModel || this.defaultModel;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
      throw new Error(`OpenAI vision error ${response.status}: ${err.error?.message || "Unknown error"}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async audio({ buffer, mimeType }) {
    const ext = (mimeType?.split("/")?.[1] || "mp3").replace("mpeg", "mp3").replace("x-wav", "wav");
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), `audio.${ext}`);
    form.append("model", "whisper-1");

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`OpenAI audio error ${response.status}: ${err.error?.message || "Unknown error"}`);
    }
    const data = await response.json();
    return data.text || "";
  }

  async *stream({ model, messages, systemPrompt, temperature = 0.7, maxTokens = 2048 }) {
    const finalModel = model || this.defaultModel;

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: "system", content: systemPrompt });
    }
    apiMessages.push(...messages);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
      throw new Error(`OpenAI API error ${response.status}: ${err.error?.message || "Unknown error"}`);
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
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") {
          yield { chunk: "", done: true };
          return;
        }

        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            yield { chunk: delta, done: false };
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }

    yield { chunk: "", done: true };
  }
}
