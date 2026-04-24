import { z } from "../types.js";

async function resolveVaultContent({ content, contentPath, workspaceId }) {
  const inline = typeof content === "string" ? content : "";
  if (inline) return inline;

  const sourcePath = typeof contentPath === "string" ? contentPath.trim() : "";
  if (!sourcePath) return "";
  if (!workspaceId) throw new Error("workspaceId manquant pour lire contentPath");

  const { readNote } = await import("../../services/vault/vault-service.js");
  const noteContent = await readNote(workspaceId, sourcePath);
  return noteContent || "";
}

export const vaultWriteAction = {
  id: "action:vault_write",
  category: "action",
  name: "Écrire dans le Vault",
  description: "Crée ou met à jour une note dans le Vault du workspace.",
  icon: "FileText",
  color: "#f39c12",

  inputSchema: z.object({
    path:    z.string().describe("Chemin de la note (ex: rapports/hebdo.md)"),
    content: z.string().optional().describe("Contenu de la note (Markdown)"),
    contentPath: z.string().optional().describe("Chemin d'une note source a copier"),
    mode: z.string().optional().describe("Mode d'ecriture: overwrite | append"),
  }),

  outputSchema: z.object({
    path:    z.string(),
    written: z.boolean(),
    mode: z.string().optional(),
  }),

  async execute(inputs, context) {
    let { path: notePath, content, contentPath, mode } = inputs;
    if (!notePath) throw new Error("path est requis");
    if (!context.workspaceId) throw new Error("workspaceId manquant dans le contexte");

    // Prepend userId if not already present and not a system path
    if (context.userId && !notePath.startsWith("Global/") && !notePath.startsWith(`${context.userId}/`)) {
      notePath = `${context.userId}/${notePath}`;
    }

    const resolvedContent = await resolveVaultContent({
      content,
      contentPath,
      workspaceId: context.workspaceId,
    });

    if (!resolvedContent) throw new Error("content est requis");

    const writeMode = String(mode || "overwrite").toLowerCase() === "append"
      ? "append"
      : "overwrite";

    const { writeNote, appendNote } = await import("../../services/vault/vault-service.js");
    if (writeMode === "append") {
      await appendNote(context.workspaceId, notePath, resolvedContent);
    } else {
      await writeNote(context.workspaceId, notePath, resolvedContent);
    }

    return { path: notePath, written: true, mode: writeMode };
  },
};
