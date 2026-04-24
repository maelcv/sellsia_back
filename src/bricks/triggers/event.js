import { z } from "../types.js";

export const eventTrigger = {
  id: "trigger:event",
  category: "trigger",
  name: "Événement plateforme",
  description: "Se déclenche sur un événement interne (conversation terminée, rappel, CRM…).",
  icon: "Zap",
  color: "#9b59b6",

  inputSchema: z.object({
    eventType: z.enum([
      "conversation.ended",
      "reminder.triggered",
      "vault.note.created",
      "crm.company.created",
      "crm.opportunity.created",
      "user.created",
    ]).describe("Type d'événement à écouter"),
    filter: z.string().optional().describe("Filtre JSON optionnel sur le payload de l'événement"),
  }),

  outputSchema: z.object({
    eventType: z.string(),
    payload:   z.any().describe("Payload complet de l'événement"),
    firedAt:   z.string(),
  }),

  async execute(inputs, _context) {
    return {
      eventType: inputs.eventType,
      payload:   {},
      firedAt:   new Date().toISOString(),
    };
  },
};
