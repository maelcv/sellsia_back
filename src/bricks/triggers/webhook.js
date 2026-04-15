import { z } from "../types.js";

export const webhookTrigger = {
  id: "trigger:webhook",
  category: "trigger",
  name: "Webhook entrant",
  description: "Déclenche le workflow quand une requête HTTP POST est reçue sur une URL dédiée.",
  icon: "Webhook",
  color: "#9b59b6",

  inputSchema: z.object({
    // Pas d'input utilisateur : le token est généré côté serveur
  }),

  outputSchema: z.object({
    body:    z.any().describe("Corps de la requête entrante"),
    headers: z.any().describe("En-têtes de la requête"),
    method:  z.string().describe("Méthode HTTP"),
  }),

  // Le trigger webhook n'a pas de fonction execute propre :
  // il est déclenché externalement via POST /api/automations/webhook/:token
  async execute(inputs, context) {
    return { info: "Trigger webhook déclenché externalement." };
  },
};
