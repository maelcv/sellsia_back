import { z } from "../types.js";

export const manualTrigger = {
  id: "trigger:manual",
  category: "trigger",
  name: "Déclenchement manuel",
  description: "Lancé manuellement via l'interface ou l'API. Accepte un payload JSON libre.",
  icon: "Play",
  color: "#27ae60",

  inputSchema: z.object({
    description: z.string().optional().describe("Description du déclenchement (affichée dans l'historique)"),
  }),

  outputSchema: z.object({
    triggeredAt: z.string(),
    triggeredBy: z.string(),
    inputData:   z.any(),
  }),

  async execute(inputs, context) {
    return {
      triggeredAt: new Date().toISOString(),
      triggeredBy: context.userId ? `user:${context.userId}` : "manual",
      inputData:   inputs,
    };
  },
};
