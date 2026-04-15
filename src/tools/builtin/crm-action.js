/**
 * CRMActionSubAgent — CRM write operations with user validation
 *
 * Features:
 * - Create/update/delete CRM objects
 * - Requires user confirmation before execution
 * - Returns validation step with action details
 */

import { BaseSubAgent } from "./base-sub-agent.js";

export class CRMActionSubAgent extends BaseSubAgent {
  constructor(provider) {
    const systemPrompt = `Tu es un sous-agent specialise dans les actions d'ecriture CRM (create/update/delete).

ROLE : Analyser la demande utilisateur et generer une action CRM a faire confirmer par l'utilisateur.

PROCESSUS :
1. Analyse la demande pour identifier l'action a faire (create company, update contact, delete opportunity, etc.)
2. Extrais tous les parametres necessaires du contexte
3. Genere une action structuree avec tous les details
4. JAMAIS executer l'action directement — toujours demander confirmation

REGLE CRITIQUE :
- Les actions d'ecriture CRM DOIVENT TOUJOURS etre validees par l'utilisateur avant execution
- Ne jamais modifier ou supprimer des donnees sans confirmation explicite
- Presenter clairement ce qui va etre change et pourquoi

TYPES D'ACTIONS :
- create: creer un nouvel objet (company, contact, opportunity)
- update: modifier un objet existant
- delete: supprimer un objet

FORMAT DE REPONSE :
\`\`\`json
{
  "think": "analyse de la demande et justification",
  "action": {
    "type": "create|update|delete",
    "object": "company|contact|opportunity|quote",
    "id": "ID numerique si applicable",
    "changes": { ... }
  },
  "confirmationMessage": "Message clair pour l'utilisateur sur ce qui va se passer"
}
\`\`\``;

    super({
      type: "crm_action",
      provider,
      tools: [], // No tools — pure analysis
      systemPrompt,
    });
  }

  /**
   * Override execute to return validation step without actually executing
   */
  async execute({ demande, contexte = "", toolContext = {}, thinkingMode = "low", onEvent = null }) {
    try {
      // Use LLM to generate the action proposal
      const chatResult = await this.provider.chat({
        systemPrompt: this.systemPrompt,
        messages: [
          {
            role: "user",
            content: `${contexte ? `Contexte:\n${contexte}\n\n` : ""}Demande:\n${demande}`,
          },
        ],
        temperature: 0.5,
        maxTokens: 2048,
      });

      const parsed = this._parseActionResponse(chatResult.content);

      return {
        demande,
        contexte,
        think: parsed.think || "",
        output: parsed.confirmationMessage || "",
        sources: [],
        tokensInput: chatResult.tokensInput || 0,
        tokensOutput: chatResult.tokensOutput || 0,
        requiresApproval: true, // Always requires approval
        action: parsed.action || null,
      };
    } catch (err) {
      console.error("[CRMActionSubAgent] Error:", err);
      return {
        demande,
        contexte,
        think: "",
        output: `Error: ${err.message}`,
        sources: [],
        tokensInput: 0,
        tokensOutput: 0,
        requiresApproval: false,
        action: null,
      };
    }
  }

  /**
   * Parse the action proposal from LLM response
   */
  _parseActionResponse(content) {
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          think: parsed.think || "",
          action: parsed.action || null,
          confirmationMessage: parsed.confirmationMessage || "",
        };
      }
    } catch {
      /* fallback */
    }

    // Fallback: extract action from raw text
    return {
      think: "",
      action: null,
      confirmationMessage: content,
    };
  }
}
