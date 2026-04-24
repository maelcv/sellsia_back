import { z } from "../types.js";

export const generateReportAction = {
  id: "action:generate_report",
  category: "action",
  name: "Generer un rapport PDF",
  description: "Genere un rapport PDF a partir de contenu markdown.",
  icon: "FileText",
  color: "#7c3aed",

  inputSchema: z.object({
    title: z.string().describe("Titre du rapport"),
    subtitle: z.string().optional().describe("Sous-titre du rapport"),
    content: z.string().describe("Contenu markdown du rapport"),
  }),

  outputSchema: z.object({
    fileId: z.string(),
    filename: z.string(),
    downloadUrl: z.string(),
  }),

  async execute(inputs, context) {
    const title = String(inputs.title || "").trim();
    const content = String(inputs.content || "").trim();

    if (!title) throw new Error("title est requis");
    if (!content) throw new Error("content est requis");

    const { generatePDF } = await import("../../tools/documents/pdf-generator.js");
    const result = await generatePDF({
      title,
      subtitle: String(inputs.subtitle || ""),
      content,
    });

    return {
      fileId: result.fileId,
      filename: result.filename,
      downloadUrl: `/api/chat/download/${result.fileId}`,
    };
  },
};
