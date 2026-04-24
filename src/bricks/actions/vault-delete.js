import { z } from "../types.js";

export const vaultDeleteAction = {
  id: "action:vault_delete",
  category: "action",
  name: "Supprimer du Vault",
  description: "Supprime une note markdown dans le Vault du workspace.",
  icon: "Trash2",
  color: "#e74c3c",

  inputSchema: z.object({
    path: z.string().describe("Chemin de la note a supprimer (ex: rapports/hebdo.md)"),
  }),

  outputSchema: z.object({
    path: z.string(),
    deleted: z.boolean(),
  }),

  async execute(inputs, context) {
    const notePath = String(inputs.path || "").trim();
    if (!notePath) throw new Error("path est requis");
    if (!context.workspaceId) throw new Error("workspaceId manquant dans le contexte");

    const { deleteNote } = await import("../../services/vault/vault-service.js");
    await deleteNote(context.workspaceId, notePath);

    return { path: notePath, deleted: true };
  },
};
