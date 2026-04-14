/**
 * TemplateAgent — Agent dynamique instancié depuis un AgentTemplate en DB.
 *
 * Contrairement aux agents hardcodés (commercial, directeur, technicien),
 * cet agent charge son prompt et ses tools depuis la base de données,
 * ce qui permet de créer de nouveaux agents sans modifier le code.
 *
 * Utilisé par le dispatcher quand agent.templateId est défini.
 */

import { BaseAgent } from "./base-agent.js";
import { getToolsForAgent } from "../tools/registry.js";
import { loadPrompt } from "../prompts/loader.js";

export class TemplateAgent extends BaseAgent {
  /**
   * @param {object} agentConfig - Objet Agent Prisma (avec template inclus si possible)
   * @param {object} [provider] - Provider LLM (optionnel, pour override)
   */
  constructor(agentConfig, provider = null) {
    super(provider);
    this.agentConfig = agentConfig;
    this.agentId = agentConfig.id;
    this.agentName = agentConfig.name;
  }

  /**
   * Exécute l'agent avec le contexte fourni.
   * Charge le prompt et les tools depuis la DB/template, puis délègue à BaseAgent.
   */
  async execute(context) {
    const {
      userMessage,
      conversationHistory = [],
      clientId = null,
      toolContext = {},
    } = context;

    // Charger le prompt (Redis → DB → seed JSON)
    const systemPrompt = await loadPrompt(this.agentId, clientId, toolContext.redisClient);

    // Charger les tools autorisés
    const availableTools = getToolsForAgent(this.agentConfig);

    // Déléguer à BaseAgent avec le prompt et les tools résolus
    return super.execute({
      ...context,
      systemPrompt,
      tools: availableTools,
    });
  }
}
