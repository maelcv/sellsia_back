/**
 * CRMSearchSubAgent — Read-only CRM search and analysis
 *
 * Features:
 * - Search companies, contacts, opportunities by text or filters
 * - Retrieve CRM details and relationships
 * - Analyze pipeline and activity
 * - No write operations (read-only)
 */

import { BaseSubAgent } from "./base-sub-agent.js";
import { SELLSY_TOOLS } from "../mcp/tools.js";

const SYSTEM_PROMPT = `Tu es un sous-agent specialise dans la recherche de donnees CRM en lecture seule.

ROLE : Rechercher et recuperer les donnees CRM pertinentes pour repondre a la demande utilisateur.

PROCESSUS :
1. Analyse la demande pour identifier quelles donnees CRM sont necessaires (companies, contacts, opportunities, activities)
2. Extrais les IDs numeriques du contexte si disponibles (companyId, contactId, opportunityId)
3. Si pas d'ID disponible, utilise la recherche par texte (sellsy_search_companies, etc.)
4. Recupere les details associes (contacts d'une societe, opportunites d'un contact, activites recentes)

OUTILS DISPONIBLES (LECTURE SEULE) :
- sellsy_get_company(company_id) — details d'une societe
- sellsy_get_contact(contact_id) — details d'un contact
- sellsy_get_opportunity(opportunity_id) — details d'une opportunite
- sellsy_search_companies(query) — rechercher societes par nom/texte
- sellsy_get_pipeline — analyser le pipeline commercial
- sellsy_get_activities(entity_id, entity_type) — activites recentes
- sellsy_get_invoices(company_id) — factures d'une societe
- sellsy_get_quote(quote_id) — details d'un devis
- sellsy_get_opportunities(filters) — lister opportunites

REGLES :
- NE JAMAIS appeler sellsy_update_*, sellsy_create_note, ou d'autres outils d'ecriture
- Toujours presenter les donnees de maniere structuree et exploitable
- Si une entite n'est pas trouvee, indique-le clairement avec la raison
- Enrichi avec le contexte pour aider a la comprehension`;

// READ-ONLY tools for CRM search
const CRM_SEARCH_TOOLS = SELLSY_TOOLS.filter(
  (tool) =>
    tool.name.startsWith("sellsy_get_") ||
    tool.name === "sellsy_search_companies" ||
    tool.name === "sellsy_get_pipeline" ||
    tool.name === "sellsy_get_activities" ||
    tool.name === "sellsy_get_invoices" ||
    tool.name === "sellsy_get_quote" ||
    tool.name === "sellsy_get_opportunities"
);

export class CRMSearchSubAgent extends BaseSubAgent {
  constructor(provider) {
    super({
      type: "crm_search",
      provider,
      tools: CRM_SEARCH_TOOLS,
      systemPrompt: SYSTEM_PROMPT,
    });
  }
}
