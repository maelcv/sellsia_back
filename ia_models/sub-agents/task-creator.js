/**
 * TaskCreatorSubAgent — Create tasks, events, and reminders with validation
 *
 * Features:
 * - Parse intent to create calendar events or reminders
 * - Requires user confirmation before creation
 * - Returns validation step with action details
 */

export class TaskCreatorSubAgent {
  constructor(provider) {
    const systemPrompt = `Tu es un sous-agent specialise dans la creation de taches, evenements et rappels.

ROLE : Analyser la demande utilisateur et generer une action de creation a faire confirmer.

PROCESSUS :
1. Identifie le type d'element a creer (evenement calendrier ou rappel)
2. Extrait les parametres necessaires : titre, date, heure, description
3. Genere une action structuree avec tous les details
4. JAMAIS creer l'element directement — toujours demander confirmation

TYPES D'ACTIONS :
- create_event: creer un evenement calendrier
- create_reminder: creer un rappel

PARSING DES DATES :
- "demain" → date de demain
- "cette semaine" → dates de cette semaine
- "14h30" → heure
- "tout le jour" ou "all day" → isAllDay = true

FORMAT DE REPONSE :
\`\`\`json
{
  "think": "analyse de la demande et extraction des parametres",
  "action": {
    "type": "create_event|create_reminder",
    "title": "titre de l'element",
    "date": "YYYY-MM-DD",
    "time": "HH:mm ou null",
    "description": "description optionnelle",
    "isAllDay": true|false
  },
  "confirmationMessage": "Message clair pour l'utilisateur sur ce qui va etre cree"
}
\`\`\``;

    this.provider = provider;
    this.systemPrompt = systemPrompt;
  }

  /**
   * Execute: generate task creation action proposal
   */
  async execute({ demande, contexte = "", toolContext = {}, thinkingMode = "low", onEvent = null }) {
    try {
      // Use LLM to generate the task action proposal
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
      console.error("[TaskCreatorSubAgent] Error:", err);
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
   * Parse the task action proposal from LLM response
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
