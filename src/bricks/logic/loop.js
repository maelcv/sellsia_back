import { z } from "../types.js";

export const loopLogic = {
  id: "logic:loop",
  category: "logic",
  name: "Boucle / ForEach",
  description: "Itère sur un tableau JSON et expose chaque item pour le reste du workflow.",
  icon: "Repeat",
  color: "#8e44ad",

  inputSchema: z.object({
    items:        z.string().describe("Tableau JSON ou variable (ex: {{step_xyz.output.results}})"),
    maxIterations: z.string().optional().describe("Limite d'itérations (défaut: 50)"),
  }),

  outputSchema: z.object({
    items:    z.any().describe("Le tableau original"),
    count:    z.number(),
    // Note: execution des sous-noeuds = géré par l'engine (loop expand)
  }),

  async execute(inputs, _context) {
    const { items, maxIterations } = inputs;
    const max = parseInt(maxIterations || "50", 10);

    let arr;
    try {
      arr = typeof items === "string" ? JSON.parse(items) : items;
    } catch {
      throw new Error("items doit être un tableau JSON valide");
    }

    if (!Array.isArray(arr)) throw new Error("items doit être un tableau");
    const limited = arr.slice(0, max);

    return { items: limited, count: limited.length };
  },
};
