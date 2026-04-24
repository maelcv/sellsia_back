import { z } from "../types.js";

const MAX_TOKENS_DEFAULT = 2048;
const TIMEOUT_MS = 60_000;

async function resolvePromptInput({ inlinePrompt, vaultPath, workspaceId }) {
  const prompt = typeof inlinePrompt === "string" ? inlinePrompt.trim() : "";
  if (prompt) return prompt;

  const normalizedPath = typeof vaultPath === "string" ? vaultPath.trim() : "";
  if (!normalizedPath) return "";
  if (!workspaceId) throw new Error("workspaceId requis pour charger un prompt depuis le Vault");

  const { readNote } = await import("../../services/vault/vault-service.js");
  const content = await readNote(workspaceId, normalizedPath);
  if (!content) {
    throw new Error(`Prompt Vault introuvable: ${normalizedPath}`);
  }
  return content;
}

function parseMaxTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_TOKENS_DEFAULT;
  return Math.min(Math.floor(parsed), 32_000);
}

function parseTemperature(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.7;
  return Math.max(0, Math.min(parsed, 2));
}

export const aiGenerateAction = {
  id: "action:ai_generate",
  category: "action",
  name: "Générer avec l'IA",
  description: "Envoie un prompt au provider IA du workspace et retourne le texte généré.",
  icon: "Sparkles",
  color: "#1abc9c",

  inputSchema: z.object({
    systemPrompt: z.string().optional().describe("Instruction système (rôle, contexte, format)"),
    systemPromptPath: z.string().optional().describe("Chemin Vault d'un prompt systeme markdown"),
    userPrompt:   z.string().optional().describe("Message utilisateur / prompt principal (supporte {{variables}})"),
    userPromptPath: z.string().optional().describe("Chemin Vault d'un prompt utilisateur markdown"),
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
    const {
      userPrompt,
      userPromptPath,
      systemPrompt,
      systemPromptPath,
      model,
      maxTokens,
      temperature,
    } = inputs;

    const resolvedUserPrompt = await resolvePromptInput({
      inlinePrompt: userPrompt,
      vaultPath: userPromptPath,
      workspaceId: context.workspaceId,
    });

    if (!resolvedUserPrompt) throw new Error("userPrompt est requis");

    const resolvedSystemPrompt = await resolvePromptInput({
      inlinePrompt: systemPrompt,
      vaultPath: systemPromptPath,
      workspaceId: context.workspaceId,
    });

    const { getProviderForTenant, getProviderForUser } = await import("../../ai-providers/index.js");
    let provider = context.workspaceId ? await getProviderForTenant(context.workspaceId) : null;
    if (!provider && context.userId) {
      provider = await getProviderForUser(context.userId);
    }
    if (!provider) throw new Error("Aucun provider IA actif pour ce workspace");

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      const result = await provider.chat({
        model:        model || undefined,
        messages:     [{ role: "user", content: resolvedUserPrompt }],
        systemPrompt: resolvedSystemPrompt || undefined,
        maxTokens:    parseMaxTokens(maxTokens),
        temperature:  parseTemperature(temperature),
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
