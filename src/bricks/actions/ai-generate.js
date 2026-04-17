import { z } from "../types.js";

const MAX_TOKENS_DEFAULT = 2048;
const TIMEOUT_MS = 60_000;

export const aiGenerateAction = {
  id: "action:ai_generate",
  category: "action",
  name: "Générer avec l'IA",
  description: "Envoie un prompt au provider IA du workspace et retourne le texte généré.",
  icon: "Sparkles",
  color: "#1abc9c",

  inputSchema: z.object({
    systemPrompt: z.string().optional().describe("Instruction système (rôle, contexte, format)"),
    userPrompt:   z.string().describe("Message utilisateur / prompt principal (supporte {{variables}})"),
    model:        z.string().optional().describe("Modèle à utiliser (laisser vide = défaut du workspace)"),
    maxTokens:    z.string().optional().describe("Nombre max de tokens en sortie (défaut: 2048)"),
    temperature:  z.string().optional().describe("Température 0-1 (défaut: 0.7)"),
  }),

  outputSchema: z.object({
    text:         z.string().describe("Texte généré"),
    tokensInput:  z.number(),
    tokensOutput: z.number(),
    model:        z.string(),
  }),

  async execute(inputs, context) {
    const { userPrompt, systemPrompt, model, maxTokens, temperature } = inputs;
    if (!userPrompt) throw new Error("userPrompt est requis");

    const { getProviderForTenant } = await import("../../ai-providers/index.js");
    const provider = await getProviderForTenant(context.workspaceId);
    if (!provider) throw new Error("Aucun provider IA actif pour ce workspace");

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      const result = await provider.chat({
        model:        model || undefined,
        messages:     [{ role: "user", content: userPrompt }],
        systemPrompt: systemPrompt || undefined,
        maxTokens:    maxTokens ? parseInt(maxTokens, 10) : MAX_TOKENS_DEFAULT,
        temperature:  temperature ? parseFloat(temperature) : 0.7,
      });

      return {
        text:         result.content,
        tokensInput:  result.tokensInput  ?? 0,
        tokensOutput: result.tokensOutput ?? 0,
        model:        result.model        ?? model ?? "unknown",
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
