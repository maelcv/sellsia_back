import { z } from "../types.js";

export const vaultWriteAction = {
  id: "action:vault_write",
  category: "action",
  name: "Écrire dans le Vault",
  description: "Crée ou met à jour une note dans le Vault du workspace.",
  icon: "FileText",
  color: "#f39c12",

  inputSchema: z.object({
    path:    z.string().describe("Chemin de la note (ex: rapports/hebdo.md)"),
    content: z.string().describe("Contenu de la note (Markdown)"),
  }),

  outputSchema: z.object({
    path:    z.string(),
    written: z.boolean(),
  }),

  async execute(inputs, context) {
    const { path: notePath, content } = inputs;
    if (!notePath) throw new Error("path est requis");
    if (!content)  throw new Error("content est requis");
    if (!context.workspaceId) throw new Error("workspaceId manquant dans le contexte");

    const { writeNote } = await import("../../services/vault/vault-service.js");
    await writeNote(context.workspaceId, notePath, content);

    return { path: notePath, written: true };
  },
};
