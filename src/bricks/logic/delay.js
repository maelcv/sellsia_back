import { z } from "../types.js";

const MAX_DELAY_MS = 5 * 60 * 1000; // 5 min max

export const delayLogic = {
  id: "logic:delay",
  category: "logic",
  name: "Délai / Pause",
  description: "Attend un délai avant de passer au nœud suivant (max 5 minutes).",
  icon: "Timer",
  color: "#7f8c8d",

  inputSchema: z.object({
    seconds: z.string().describe("Durée en secondes (ex: 30, max 300)"),
  }),

  outputSchema: z.object({
    waited:    z.number().describe("Temps réellement attendu en ms"),
    resumedAt: z.string(),
  }),

  async execute(inputs, _context) {
    const sec = Math.min(Math.max(parseInt(inputs.seconds || "0", 10), 0), 300);
    const ms  = sec * 1000;
    const capped = Math.min(ms, MAX_DELAY_MS);

    await new Promise((resolve) => setTimeout(resolve, capped));

    return { waited: capped, resumedAt: new Date().toISOString() };
  },
};
