import { z } from "../types.js";

export const vaultReadAction = {
  id: "action:vault_read",
  category: "action",
  name: "Lire depuis le Vault",
  description: "Lit le contenu d'une note existante dans le Vault du workspace.",
  icon: "BookOpen",
  color: "#e67e22",

  inputSchema: z.object({
    path: z.string().describe("Chemin de la note à lire (ex: rapports/hebdo.md)"),
    defaultValue: z.string().optional().describe("Valeur de secours si la note est absente"),
    failIfMissing: z.string().optional().describe("true pour echouer si la note est absente"),
  }),

  outputSchema: z.object({
    path:    z.string(),
    content: z.string(),
    found:   z.boolean(),
  }),

  async execute(inputs, context) {
    const { path: notePath, defaultValue, failIfMissing } = inputs;
    if (!notePath) throw new Error("path est requis");
    if (!context.workspaceId) throw new Error("workspaceId manquant dans le contexte");

    const { readNote } = await import("../../services/vault/vault-service.js");
    const content = await readNote(context.workspaceId, notePath);

    const shouldFail = String(failIfMissing || "").toLowerCase() === "true";
    if (content === null && shouldFail) {
      throw new Error(`Note introuvable: ${notePath}`);
    }

    const fallback = typeof defaultValue === "string" ? defaultValue : "";
    const finalContent = content === null ? fallback : content;

    return {
      path:    notePath,
      content: finalContent,
      found:   content !== null,
    };
  },
};
