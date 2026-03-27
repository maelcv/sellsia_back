/**
 * DynamicSubAgent — Sous-agent instancié depuis une définition en base de données.
 *
 * Permet à n'importe quelle SubAgentDefinition créée via l'interface admin ou
 * client d'être exécutée dans le pipeline exactement comme un sous-agent codé en dur.
 *
 * Flow :
 *   1. Charger SubAgentDefinition depuis Prisma (par id ou nom)
 *   2. Résoudre les capacités → outils via CAPABILITY_TOOLS
 *   3. Injecter les instructions universelles (ask_user, règles IDs Sellsy)
 *   4. Déléguer l'exécution à BaseSubAgent
 */

import { BaseSubAgent } from "./base-sub-agent.js";
import { resolveTools } from "./capability-tool-map.js";
import { prisma } from "../../src/prisma.js";

// ─────────────────────────────────────────────────────────────────────────────
// INSTRUCTIONS UNIVERSELLES injectées dans TOUS les sous-agents dynamiques
// ─────────────────────────────────────────────────────────────────────────────
//
// Ces règles sont critiques pour l'exactitude et la sécurité. Elles s'ajoutent
// à la fin de chaque system prompt personnalisé pour garantir un comportement
// cohérent quel que soit le prompt métier.

const UNIVERSAL_RULES = `
--- RÈGLES UNIVERSELLES (prioritaires sur toute autre instruction) ---

**Outil ask_user — Quand et comment l'utiliser :**
- Si la demande est ambiguë et que tu ne peux pas choisir sans risque d'erreur → appelle ask_user
- Si une opération d'écriture (créer, modifier, supprimer) touche plusieurs entités possibles → appelle ask_user AVANT d'agir
- Format obligatoire : { question: "question claire", suggestions: ["option A", "option B", "option C"] }
- Les suggestions doivent être concrètes et actionnables (jamais "autre" seul)
- Exemple : { question: "Sur quelle opportunité dois-je mettre à jour le statut ?", suggestions: ["Acme Corp — 45 000€ (Négociation)", "Acme Corp — 12 000€ (Qualification)", "Me préciser l'ID manuellement"] }

**Résolution d'entités CRM Sellsy :**
- Les IDs Sellsy sont toujours des entiers numériques (ex: 92, 85, 107)
- companyId → sellsy_get_company | contactId → sellsy_get_contact | opportunityId → sellsy_get_opportunity
- Si le type est inconnu, teste dans l'ordre : company → contact → opportunity avec le MÊME ID
- JAMAIS utiliser un nom comme valeur d'un paramètre *_id

**Données liées (CRM) :**
- Contact d'une société : sellsy_get_company → extraire contactId → sellsy_get_contact
- Société d'une opportunité : sellsy_get_opportunity → extraire companyId → sellsy_get_company
- Ne jamais supposer ; toujours chaîner les appels pour remonter les relations

**Opérations d'écriture :**
- Toujours lire l'entité d'abord pour valider son existence avant modification
- Toujours appeler avec confirmed=false en premier — attendre validation utilisateur
- En cas de doute sur le périmètre de la modification → ask_user

**Outils non listés :**
- N'appelle JAMAIS un outil qui n'est pas dans ta liste d'outils disponibles
- Si un outil manque pour compléter ta mission → indique-le dans ton output

--- FORMAT DE RÉPONSE ---
Réponds UNIQUEMENT en JSON :
\`\`\`json
{
  "think": "ton raisonnement interne sur la demande, les données et les décisions prises",
  "output": "le résultat final à retourner (texte structuré, données, recommandations)",
  "sources": ["source1", "source2"]
}
\`\`\`
`;

// ─────────────────────────────────────────────────────────────────────────────

export class DynamicSubAgent extends BaseSubAgent {
  /**
   * Crée un DynamicSubAgent depuis une définition DB déjà chargée.
   *
   * @param {Object} params
   * @param {Object} params.definition - SubAgentDefinition record (Prisma)
   * @param {Object} params.provider - LLM provider instance
   */
  constructor({ definition, provider }) {
    const capabilities = _parseCapabilities(definition.capabilities);
    const resolvedTools = resolveTools(capabilities);

    const fullSystemPrompt = _buildSystemPrompt(definition.name, definition.systemPrompt, capabilities);

    super({
      type: `db:${definition.id}`,
      provider,
      tools: resolvedTools,
      systemPrompt: fullSystemPrompt,
    });

    this.definition = definition;
    this.capabilities = capabilities;
  }

  /**
   * Charge une SubAgentDefinition depuis la DB et retourne un DynamicSubAgent.
   *
   * @param {string} definitionId - ID de la SubAgentDefinition
   * @param {Object} provider - LLM provider instance
   * @param {Object} [workspaceId] - Pour la vérification d'isolation workspace
   * @returns {Promise<DynamicSubAgent|null>}
   */
  static async fromId(definitionId, provider, workspaceId = null) {
    const definition = await prisma.subAgentDefinition.findUnique({
      where: { id: definitionId },
    });

    if (!definition || !definition.isActive) {
      console.warn(`[DynamicSubAgent] Definition not found or inactive: ${definitionId}`);
      return null;
    }

    // Isolation workspace : un sous-agent workspace-scoped n'est accessible
    // que depuis son propre workspace (ou par un admin avec workspaceId=null)
    if (definition.workspaceId && workspaceId && definition.workspaceId !== workspaceId) {
      console.warn(`[DynamicSubAgent] SECURITY: ${definitionId} belongs to workspace ${definition.workspaceId}, blocked from ${workspaceId}`);
      return null;
    }

    return new DynamicSubAgent({ definition, provider });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _parseCapabilities(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function _buildSystemPrompt(name, customPrompt, capabilities) {
  const parts = [];

  // 1. Custom expert prompt from DB (the heart of the sub-agent's expertise)
  if (customPrompt?.trim()) {
    parts.push(customPrompt.trim());
  } else {
    parts.push(`Tu es ${name}, un sous-agent spécialisé de la plateforme Sellsia.`);
  }

  // 2. Capability context: tell the agent what domains it has access to
  if (capabilities.length > 0) {
    const capLabels = {
      crm_sellsy_read:      "lecture CRM Sellsy",
      crm_sellsy_write:     "écriture CRM Sellsy",
      crm_salesforce_read:  "lecture CRM Salesforce",
      crm_salesforce_write: "écriture CRM Salesforce",
      pipeline_analyze:     "analyse pipeline commercial",
      web_search:           "recherche web",
      web_scrape:           "scraping web",
      file_office_read:     "lecture fichiers Office",
      file_office_write:    "génération fichiers Office",
      file_pdf_read:        "lecture PDF",
      file_pdf_write:       "génération PDF",
      image_ocr:            "OCR / analyse d'images",
      knowledge_cache:      "cache de réponses",
      knowledge_sort:       "tri base de connaissance",
      email_read:           "lecture emails",
      email_send:           "envoi emails",
      calendar_read:        "lecture calendrier",
      calendar_write:       "écriture calendrier",
      admin_platform:       "analyse plateforme (admin)",
    };
    const labels = capabilities.map((c) => capLabels[c] ?? c).join(", ");
    parts.push(`\nDomaines d'action : ${labels}.`);
  }

  // 3. Universal rules (always last, always highest priority)
  parts.push(UNIVERSAL_RULES);

  return parts.join("\n\n");
}
