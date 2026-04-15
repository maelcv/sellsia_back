/**
 * Base LLM Provider — Interface commune pour tous les providers IA.
 * Chaque provider (OpenAI, Anthropic, Mistral, Ollama) implémente cette interface.
 */

export class BaseLLMProvider {
  constructor(config = {}) {
    this.providerName = "base";
    this.config = config;
  }

  /**
   * Envoie un message au LLM et retourne la réponse complète.
   * @param {Object} params
   * @param {string} params.model - Modèle à utiliser
   * @param {Array<{role: string, content: string}>} params.messages - Historique de conversation
   * @param {string} [params.systemPrompt] - Prompt système
   * @param {number} [params.temperature=0.7] - Température
   * @param {number} [params.maxTokens=2048] - Tokens max en sortie
   * @returns {Promise<{content: string, tokensInput: number, tokensOutput: number, model: string}>}
   */
  async chat(_params) {
    throw new Error(`chat() not implemented for provider: ${this.providerName}`);
  }

  /**
   * Envoie un message et retourne un stream de tokens.
   * @param {Object} params - Mêmes paramètres que chat()
   * @returns {AsyncGenerator<{chunk: string, done: boolean}>}
   */
  async *stream(_params) {
    throw new Error(`stream() not implemented for provider: ${this.providerName}`);
  }

  /**
   * Envoie un message avec des tools disponibles et retourne la réponse.
   * Les providers qui supportent le tool-calling (function-calling) surchargent cette méthode.
   *
   * @param {Object} params
   * @param {string} [params.model]
   * @param {Array<{role: string, content: string}>} params.messages
   * @param {string} [params.systemPrompt]
   * @param {number} [params.temperature=0.7]
   * @param {number} [params.maxTokens=2048]
   * @param {Array} [params.tools] - Tools au format du provider
   * @returns {Promise<{content: string, toolCalls: Array|null, tokensInput: number, tokensOutput: number, model: string, provider: string}>}
   */
  async chatWithTools(params) {
    // Default: ignore tools and fall back to regular chat
    const result = await this.chat(params);
    return { ...result, toolCalls: null };
  }

  /**
   * Classification rapide d'intention (appel léger, réponse JSON).
   * @param {string} systemPrompt
   * @param {string} userMessage
   * @param {string} [model]
   * @returns {Promise<Object>} - JSON parsé
   */
  async classify(systemPrompt, userMessage, model) {
    const result = await this.chat({
      model: model || this.config.defaultModel,
      systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      temperature: 0.1,
      maxTokens: 512
    });

    try {
      // Extraire le JSON de la réponse (supporte ```json ... ``` ou JSON brut)
      const jsonMatch = result.content.match(/```json\s*([\s\S]*?)```/) ||
                        result.content.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      return JSON.parse(result.content);
    } catch {
      return { raw: result.content, parseError: true };
    }
  }
}
