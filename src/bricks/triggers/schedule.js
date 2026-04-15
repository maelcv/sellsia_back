import { z } from "../types.js";

export const scheduleTrigger = {
  id: "trigger:schedule",
  category: "trigger",
  name: "Planifié (cron)",
  description: "Déclenche le workflow à intervalles réguliers définis par une expression cron.",
  icon: "Clock",
  color: "#e67e22",

  inputSchema: z.object({
    cronExpr: z.string().describe("Expression cron (ex: '0 9 * * 1' = lundi 9h)"),
    timezone: z.string().optional().describe("Fuseau horaire (ex: Europe/Paris)"),
  }),

  outputSchema: z.object({
    firedAt:  z.string().describe("Timestamp ISO d'exécution"),
    cronExpr: z.string().describe("Expression cron utilisée"),
  }),

  async execute(inputs, context) {
    return {
      firedAt:  new Date().toISOString(),
      cronExpr: inputs.cronExpr || "",
    };
  },
};
