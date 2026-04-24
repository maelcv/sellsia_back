/**
 * Generaliste Agent — Agent de fallback hors specialites CRM.
 * Utilise le socle BaseAgent avec un contexte minimal et web-first.
 */

import { BaseAgent } from "./base-agent.js";

export class GeneralisteAgent extends BaseAgent {
  constructor({ provider, systemPrompt }) {
    super({ agentId: "generaliste", provider, systemPrompt });
  }

  buildContextBlock(_sellsyData, pageContext) {
    if (!pageContext || typeof pageContext !== "object") {
      return "Aucun contexte CRM specifique. Priorise les informations externes verifiables.";
    }

    const lines = [];
    if (pageContext.type) lines.push(`- Type page: ${pageContext.type}`);
    if (pageContext.entityName) lines.push(`- Entite: ${pageContext.entityName}`);
    if (pageContext.entityId) lines.push(`- Identifiant: ${pageContext.entityId}`);

    if (lines.length === 0) {
      return "Aucun contexte CRM specifique. Priorise les informations externes verifiables.";
    }

    return `Contexte de page disponible:\n${lines.join("\n")}\nUtilise ce contexte uniquement s'il est pertinent pour la demande.`;
  }
}
