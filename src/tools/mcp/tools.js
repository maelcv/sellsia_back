/**
 * MCP Tool Registry — In-process tool definitions for agent tool-calling.
 *
 * Each tool has:
 *   - name: unique identifier
 *   - description: what the tool does (injected into LLM prompt)
 *   - parameters: JSON Schema for the tool parameters (OpenAI function-calling format)
 *   - execute(params, context): async function that runs the tool
 *
 * Context is per-request state: { sellsyClient, tavilyApiKey, uploadedFiles }
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import {
  canReadVaultToolContext,
  canWriteVaultToolContext,
} from "../../services/access/workspace-capabilities.js";

// Resolve npm packages from dashboard/node_modules
const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDir = resolve(__dirname, "../../dashboard");
const require = createRequire(resolve(dashboardDir, "index.js"));

// ── Sellsy Tools ──────────────────────────────────────

const sellsy_get_company = {
  name: "sellsy_get_company",
  description:
    "Récupère les informations détaillées d'une société dans Sellsy (nom, email, téléphone, site web, adresse, SIRET, etc.).",
  parameters: {
    type: "object",
    properties: {
      company_id: {
        type: "string",
        description: "L'identifiant Sellsy de la société"
      }
    },
    required: ["company_id"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const company = await context.sellsyClient.getCompany(params.company_id);
    return company;
  }
};

const sellsy_get_contact = {
  name: "sellsy_get_contact",
  description:
    "Récupère les informations d'un contact Sellsy (nom, prénom, email, téléphone, poste, etc.).",
  parameters: {
    type: "object",
    properties: {
      contact_id: {
        type: "string",
        description: "L'identifiant Sellsy du contact"
      }
    },
    required: ["contact_id"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const contact = await context.sellsyClient.getContact(params.contact_id);
    return contact;
  }
};

const sellsy_get_opportunity = {
  name: "sellsy_get_opportunity",
  description:
    "Récupère les détails d'une opportunité/deal Sellsy (nom, montant, probabilité, statut, étape, client lié, contact lié, etc.).",
  parameters: {
    type: "object",
    properties: {
      opportunity_id: {
        type: "string",
        description: "L'identifiant Sellsy de l'opportunité"
      }
    },
    required: ["opportunity_id"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const opp = await context.sellsyClient.getOpportunity(params.opportunity_id);
    return opp;
  }
};

const sellsy_search_companies = {
  name: "sellsy_search_companies",
  description:
    "Recherche des sociétés dans Sellsy par nom ou mot-clé. Retourne une liste de résultats.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Terme de recherche (nom de société, mot-clé, etc.)"
      },
      limit: {
        type: "number",
        description: "Nombre maximum de résultats (défaut 5)"
      }
    },
    required: ["query"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const results = await context.sellsyClient.searchCompanies(params.query, params.limit || 5);
    return results;
  }
};

const sellsy_get_pipeline = {
  name: "sellsy_get_pipeline",
  description:
    "Récupère l'analyse complète du pipeline commercial : pipelines, étapes, nombre d'opportunités par étape, montants, opportunités stagnantes.",
  parameters: {
    type: "object",
    properties: {},
    required: []
  },
  async execute(_params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const analysis = await context.sellsyClient.getPipelineAnalysis();
    return analysis;
  }
};

const sellsy_get_activities = {
  name: "sellsy_get_activities",
  description:
    "Récupère les activités récentes liées à une entité Sellsy (appels, emails, RDV, notes, tâches).",
  parameters: {
    type: "object",
    properties: {
      entity_type: {
        type: "string",
        enum: ["company", "contact", "opportunity"],
        description: "Type de l'entité"
      },
      entity_id: {
        type: "string",
        description: "Identifiant de l'entité"
      },
      limit: {
        type: "number",
        description: "Nombre d'activités à récupérer (défaut 20)"
      }
    },
    required: ["entity_type", "entity_id"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const activities = await context.sellsyClient.getActivities(
      params.entity_type,
      params.entity_id,
      params.limit || 20
    );
    return activities;
  }
};

const sellsy_get_invoices = {
  name: "sellsy_get_invoices",
  description:
    "Récupère les factures depuis Sellsy, avec filtres optionnels. Utile pour le reporting financier.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Nombre max de factures (défaut 25)"
      }
    },
    required: []
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const invoices = await context.sellsyClient.getInvoices({}, params.limit || 25);
    return invoices;
  }
};

const sellsy_get_quote = {
  name: "sellsy_get_quote",
  description:
    "Récupère les détails d'un devis/estimate Sellsy (numéro, sujet, statut, montant, client lié, etc.).",
  parameters: {
    type: "object",
    properties: {
      quote_id: {
        type: "string",
        description: "L'identifiant Sellsy du devis"
      }
    },
    required: ["quote_id"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const quote = await context.sellsyClient.getQuote(params.quote_id);
    return quote;
  }
};

const sellsy_get_opportunities = {
  name: "sellsy_get_opportunities",
  description:
    "Recherche et liste les opportunités dans Sellsy avec filtres. Retourne les dernières opportunités mises à jour.",
  parameters: {
    type: "object",
    properties: {
      pipeline_id: {
        type: "string",
        description: "Filtrer par pipeline (optionnel)"
      },
      limit: {
        type: "number",
        description: "Nombre max de résultats (défaut 25)"
      }
    },
    required: []
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    const filters = {};
    if (params.pipeline_id) filters.pipeline_id = params.pipeline_id;
    const opps = await context.sellsyClient.getOpportunities(filters, params.limit || 25);
    return opps;
  }
};

// ── Web Search Tool (Tavily) ──────────────────────────

const web_search = {
  name: "web_search",
  description:
    "Recherche sur internet via Tavily. RÈGLE CRITIQUE pour la recherche d'entreprise : inclus TOUJOURS le nom exact de l'entreprise ET sa ville/pays dans la requête pour éviter de confondre avec des homonymes (ex: 'Kiliogene Bordeaux site officiel' et non 'Kiliogene' seul). Après avoir obtenu les résultats, vérifie que chaque résultat correspond bien à l'entité recherchée (même nom, même ville, même secteur) — si les résultats semblent hors-sujet, reformule la requête avec plus de précision. Croise toujours plusieurs sources avant de conclure.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "La requête de recherche web"
      },
      max_results: {
        type: "number",
        description: "Nombre max de résultats (défaut 5, max 10)"
      },
      search_depth: {
        type: "string",
        enum: ["basic", "advanced"],
        description: "Profondeur de recherche : 'basic' (rapide) ou 'advanced' (plus complet)"
      }
    },
    required: ["query"]
  },
  async execute(params, context) {
    if (!context.tavilyApiKey) {
      return { error: "Clé API Tavily non configurée. Configurez TAVILY_API_KEY dans les variables d'environnement." };
    }

    try {
      const { tavily } = require("@tavily/core");
      const client = tavily({ apiKey: context.tavilyApiKey });
      const thinkingMode = context.thinkingMode || "low";
      const priorityDomains = Array.isArray(context.priorityDomains) ? context.priorityDomains : [];
      const minResults = thinkingMode === "high" ? 10 : 6;
      const maxResults = Math.min(Math.max(params.max_results || minResults, minResults), 12);
      const searchDepth = params.search_depth || "advanced";
      const queryWithDomains = priorityDomains.length > 0
        ? `${params.query} (${priorityDomains.map((d) => `site:${d}`).join(" OR ")})`
        : params.query;

      const response = await client.search(params.query, {
        maxResults,
        searchDepth,
        includeAnswer: false,
        includeRawContent: false
      });

      let results = Array.isArray(response.results) ? response.results : [];

      // If no priority-domain result appears, run a focused pass on priority domains.
      if (priorityDomains.length > 0) {
        const hasPriorityResult = results.some((r) => {
          try {
            const host = new URL(r.url).hostname;
            return priorityDomains.some((domain) => host.endsWith(domain));
          } catch {
            return false;
          }
        });

        if (!hasPriorityResult) {
          const focused = await client.search(queryWithDomains, {
            maxResults: Math.min(6, maxResults),
            searchDepth,
            includeAnswer: false,
            includeRawContent: false
          });
          const focusedResults = Array.isArray(focused.results) ? focused.results : [];
          results = [...focusedResults, ...results];
        }
      }

      const deduped = [];
      const seen = new Set();
      for (const r of results) {
        if (!r?.url || seen.has(r.url)) continue;
        seen.add(r.url);
        deduped.push(r);
        if (deduped.length >= maxResults) break;
      }

      return {
        query: params.query,
        thinkingMode,
        crossChecked: deduped.length >= 3,
        results: deduped.map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content?.slice(0, 500),
          score: r.score
        }))
      };
    } catch (error) {
      return { error: `Recherche web échouée: ${error.message}` };
    }
  }
};

// ── Web Scrape Tool (Tavily Extract) ──────────────────

const web_scrape = {
  name: "web_scrape",
  description:
    "Extrait le contenu textuel d'une ou plusieurs URLs spécifiques via Tavily Extract. IMPORTANT : ne scrape QUE des URLs dont le titre ou le domaine indique clairement qu'elles concernent l'entité recherchée (nom de l'entreprise dans l'URL ou le titre). N'appelle JAMAIS cet outil sur une URL dont tu n'es pas certain de la pertinence.",
  parameters: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "Liste d'URLs à scraper (1 à 5 URLs)"
      }
    },
    required: ["urls"]
  },
  async execute(params, context) {
    if (!context.tavilyApiKey) {
      return { error: "Clé API Tavily non configurée. Configurez TAVILY_API_KEY dans les variables d'environnement." };
    }
    if (!Array.isArray(params.urls) || params.urls.length === 0) {
      return { error: "Veuillez fournir au moins une URL à scraper." };
    }
    const urls = params.urls.slice(0, 5); // Max 5 URLs

    try {
      const { tavily } = require("@tavily/core");
      const client = tavily({ apiKey: context.tavilyApiKey });
      const response = await client.extract(urls);

      const results = Array.isArray(response.results) ? response.results : [];
      return {
        urls: urls,
        results: results.map((r) => ({
          url: r.url,
          rawContent: r.rawContent?.slice(0, 6000),
          truncated: (r.rawContent?.length || 0) > 6000
        })),
        failedUrls: Array.isArray(response.failedResults)
          ? response.failedResults.map((r) => r.url)
          : []
      };
    } catch (error) {
      return { error: `Scraping échoué: ${error.message}` };
    }
  }
};

// ── Interaction Tools ─────────────────────────────────

const ask_user = {
  name: "ask_user",
  description:
    "Demande des précisions à l'utilisateur via un widget interactif avec suggestions de réponse. Utilise cet outil quand la demande est trop vague pour répondre avec précision et que le contexte CRM ne suffit pas. RÈGLE : utilise-le en DÉBUT de traitement (avant d'appeler d'autres outils). Ne l'utilise pas si tu peux raisonnablement déduire la réponse du contexte.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "La question à poser à l'utilisateur (claire et concise)"
      },
      suggestions: {
        type: "array",
        items: { type: "string" },
        description: "2 à 4 réponses suggérées affichées comme boutons (optionnel)"
      },
      context: {
        type: "string",
        description: "Contexte optionnel expliquant pourquoi tu poses cette question"
      }
    },
    required: ["question"]
  },
  async execute(params) {
    return {
      type: "ask_user_pending",
      question: params.question,
      suggestions: Array.isArray(params.suggestions) ? params.suggestions : [],
      context: params.context || null,
      message: `Question transmise à l'utilisateur : "${params.question}". ${Array.isArray(params.suggestions) && params.suggestions.length > 0 ? `Suggestions : ${params.suggestions.join(", ")}. ` : ""}Présente cette question dans ta réponse. N'essaie PAS d'y répondre toi-même — attends la réponse de l'utilisateur.`
    };
  }
};

// ── Navigation Tool ────────────────────────────────────

const navigate_to = {
  name: "navigate_to",
  description:
    "Redirige l'utilisateur vers une entité Sellsy spécifique (société, opportunité, contact, devis). Utilise cet outil quand l'utilisateur demande d'ouvrir, afficher ou naviguer vers une entité précise.",
  parameters: {
    type: "object",
    properties: {
      entity_type: {
        type: "string",
        enum: ["company", "opportunity", "contact", "quote"],
        description: "Type d'entité Sellsy"
      },
      entity_id: {
        type: "string",
        description: "Identifiant Sellsy de l'entité"
      },
      new_tab: {
        type: "boolean",
        description: "Ouvrir dans un nouvel onglet (défaut: false)"
      }
    },
    required: ["entity_type", "entity_id"]
  },
  async execute(params) {
    const labels = { company: "société", opportunity: "opportunité", contact: "contact", quote: "devis" };
    const label = labels[params.entity_type] || params.entity_type;
    return {
      type: "navigate",
      entity_type: params.entity_type,
      entity_id: String(params.entity_id),
      new_tab: Boolean(params.new_tab),
      message: `Navigation vers la ${label} #${params.entity_id} déclenchée${params.new_tab ? " dans un nouvel onglet" : ""}. Informe l'utilisateur de la redirection.`
    };
  }
};

// ── Sellsy Write Tools ────────────────────────────────

const sellsy_update_opportunity = {
  name: "sellsy_update_opportunity",
  description:
    "Modifie les champs d'une opportunité Sellsy. RÈGLE CRITIQUE : appelle d'abord cet outil SANS `confirmed: true` pour obtenir un récapitulatif des modifications à présenter à l'utilisateur. Appelle-le ensuite avec `confirmed: true` uniquement après confirmation explicite de l'utilisateur.",
  parameters: {
    type: "object",
    properties: {
      opportunity_id: {
        type: "string",
        description: "Identifiant Sellsy de l'opportunité"
      },
      changes: {
        type: "object",
        description: "Champs à modifier. Exemples : { name, amount, probability, note, due_date, status }",
        properties: {
          name: { type: "string" },
          amount: { type: "number" },
          probability: { type: "number", description: "0 à 100" },
          note: { type: "string" },
          due_date: { type: "string", description: "Format YYYY-MM-DD" },
          status: { type: "string", enum: ["open", "won", "lost"] }
        }
      },
      confirmed: {
        type: "boolean",
        description: "Mettre à true uniquement après confirmation explicite de l'utilisateur"
      }
    },
    required: ["opportunity_id", "changes"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };

    if (params.confirmed !== true) {
      // Return a preview without executing
      return {
        status: "pending_confirmation",
        action: "update_opportunity",
        opportunity_id: params.opportunity_id,
        changes: params.changes,
        message: `Récapitulatif des modifications pour l'opportunité #${params.opportunity_id} :\n${Object.entries(params.changes).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\nPrésente ce récapitulatif à l'utilisateur et demande : "Souhaitez-vous appliquer ces modifications ?" N'appelle PAS cet outil avec confirmed=true tant que l'utilisateur n'a pas confirmé explicitement.`
      };
    }

    try {
      const updated = await context.sellsyClient.updateOpportunity(params.opportunity_id, params.changes);
      return {
        status: "success",
        message: `Opportunité #${params.opportunity_id} mise à jour avec succès.`,
        data: updated
      };
    } catch (err) {
      return { error: `Erreur lors de la mise à jour : ${err.message}` };
    }
  }
};

const sellsy_update_company = {
  name: "sellsy_update_company",
  description:
    "Modifie les champs d'une société Sellsy. RÈGLE CRITIQUE : appelle d'abord cet outil SANS `confirmed: true` pour obtenir un récapitulatif à valider par l'utilisateur. Appelle ensuite avec `confirmed: true` seulement après confirmation explicite.",
  parameters: {
    type: "object",
    properties: {
      company_id: {
        type: "string",
        description: "Identifiant Sellsy de la société"
      },
      changes: {
        type: "object",
        description: "Champs à modifier. Exemples : { name, email, phone_number, website, note }",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          phone_number: { type: "string" },
          website: { type: "string" },
          note: { type: "string" }
        }
      },
      confirmed: {
        type: "boolean",
        description: "Mettre à true uniquement après confirmation explicite de l'utilisateur"
      }
    },
    required: ["company_id", "changes"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };

    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "update_company",
        company_id: params.company_id,
        changes: params.changes,
        message: `Récapitulatif des modifications pour la société #${params.company_id} :\n${Object.entries(params.changes).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\nPrésente ce récapitulatif à l'utilisateur et demande : "Souhaitez-vous appliquer ces modifications ?" N'appelle PAS cet outil avec confirmed=true tant que l'utilisateur n'a pas confirmé explicitement.`
      };
    }

    try {
      const updated = await context.sellsyClient.updateCompany(params.company_id, params.changes);
      return {
        status: "success",
        message: `Société #${params.company_id} mise à jour avec succès.`,
        data: updated
      };
    } catch (err) {
      return { error: `Erreur lors de la mise à jour : ${err.message}` };
    }
  }
};

const sellsy_create_note = {
  name: "sellsy_create_note",
  description:
    "Crée une note/commentaire sur une entité Sellsy (société, contact, opportunité). Pas de confirmation requise.",
  parameters: {
    type: "object",
    properties: {
      entity_type: {
        type: "string",
        enum: ["company", "contact", "opportunity"],
        description: "Type de l'entité"
      },
      entity_id: {
        type: "string",
        description: "Identifiant de l'entité"
      },
      content: {
        type: "string",
        description: "Contenu de la note"
      }
    },
    required: ["entity_type", "entity_id", "content"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    try {
      const result = await context.sellsyClient.createNote(params.entity_type, params.entity_id, params.content);
      return { status: "success", message: "Note créée avec succès.", data: result };
    } catch (err) {
      return { error: `Erreur lors de la création de la note : ${err.message}` };
    }
  }
};

// ── Sellsy — Recherche globale multi-entités ───────────

const sellsy_global_search = {
  name: "sellsy_global_search",
  description:
    "Recherche simultanément dans toutes les entités Sellsy (sociétés, contacts, opportunités) avec un seul terme. Utile quand on ne sait pas quel type d'entité chercher.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Terme de recherche (nom, email, téléphone, etc.)"
      },
      limit: {
        type: "number",
        description: "Nombre de résultats par catégorie (défaut 5)"
      }
    },
    required: ["query"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    try {
      const results = await context.sellsyClient.globalSearch(params.query, params.limit || 5);
      return results;
    } catch (err) {
      return { error: `Erreur lors de la recherche globale : ${err.message}` };
    }
  }
};

// ── Sellsy — Recherche de contacts ────────────────────

const sellsy_search_contacts = {
  name: "sellsy_search_contacts",
  description:
    "Recherche des contacts dans Sellsy par nom, prénom ou email. Retourne une liste de contacts correspondants.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Terme de recherche (nom, prénom, email, téléphone)"
      },
      limit: {
        type: "number",
        description: "Nombre maximum de résultats (défaut 10)"
      }
    },
    required: ["query"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    try {
      const results = await context.sellsyClient.searchContacts(params.query, params.limit || 10);
      return results;
    } catch (err) {
      return { error: `Erreur lors de la recherche de contacts : ${err.message}` };
    }
  }
};

// ── Sellsy — Créer un contact ─────────────────────────

const sellsy_create_contact = {
  name: "sellsy_create_contact",
  description:
    "Crée un nouveau contact dans Sellsy. Fournir au minimum le prénom et le nom. RÈGLE : présenter d'abord un récapitulatif avec ask_user avant de créer.",
  parameters: {
    type: "object",
    properties: {
      first_name: { type: "string", description: "Prénom du contact" },
      last_name: { type: "string", description: "Nom du contact" },
      email: { type: "string", description: "Adresse email (optionnel)" },
      phone_number: { type: "string", description: "Téléphone (optionnel)" },
      mobile_number: { type: "string", description: "Mobile (optionnel)" },
      position: { type: "string", description: "Poste/fonction (optionnel)" },
      company_id: { type: "string", description: "ID de la société à lier (optionnel)" },
      note: { type: "string", description: "Note libre (optionnel)" },
      confirmed: { type: "boolean", description: "true = créer, false = afficher récapitulatif" }
    },
    required: ["first_name", "last_name"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "create_contact",
        data: params,
        message: `Récapitulatif du contact à créer :\n- Nom : ${params.first_name} ${params.last_name}\n- Email : ${params.email || "—"}\n- Téléphone : ${params.phone_number || "—"}\n- Poste : ${params.position || "—"}\n\nPrésente ce récapitulatif et demande confirmation avant de créer.`
      };
    }
    try {
      const payload = {
        first_name: params.first_name,
        last_name: params.last_name
      };
      if (params.email) payload.email = params.email;
      if (params.phone_number) payload.phone_number = params.phone_number;
      if (params.mobile_number) payload.mobile_number = params.mobile_number;
      if (params.position) payload.position = params.position;
      if (params.note) payload.note = params.note;
      if (params.company_id) payload.company_id = Number(params.company_id);
      const result = await context.sellsyClient.createContact(payload);
      return { status: "success", message: `Contact ${params.first_name} ${params.last_name} créé (ID: ${result.id}).`, data: result };
    } catch (err) {
      return { error: `Erreur lors de la création du contact : ${err.message}` };
    }
  }
};

// ── Sellsy — Mettre à jour un contact ────────────────

const sellsy_update_contact = {
  name: "sellsy_update_contact",
  description:
    "Modifie les champs d'un contact Sellsy. RÈGLE CRITIQUE : appelle d'abord sans `confirmed: true` pour obtenir un récapitulatif à valider.",
  parameters: {
    type: "object",
    properties: {
      contact_id: { type: "string", description: "Identifiant Sellsy du contact" },
      changes: {
        type: "object",
        description: "Champs à modifier",
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          email: { type: "string" },
          phone_number: { type: "string" },
          mobile_number: { type: "string" },
          position: { type: "string" },
          note: { type: "string" }
        }
      },
      confirmed: { type: "boolean", description: "true uniquement après confirmation explicite" }
    },
    required: ["contact_id", "changes"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "update_contact",
        contact_id: params.contact_id,
        changes: params.changes,
        message: `Récapitulatif des modifications pour le contact #${params.contact_id} :\n${Object.entries(params.changes).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\nDemande confirmation avant d'appliquer.`
      };
    }
    try {
      const updated = await context.sellsyClient.updateContact(params.contact_id, params.changes);
      return { status: "success", message: `Contact #${params.contact_id} mis à jour.`, data: updated };
    } catch (err) {
      return { error: `Erreur lors de la mise à jour : ${err.message}` };
    }
  }
};

// ── Sellsy — Créer une société ────────────────────────

const sellsy_create_company = {
  name: "sellsy_create_company",
  description:
    "Crée une nouvelle société/entreprise dans Sellsy. RÈGLE : présenter un récapitulatif avec ask_user avant de créer.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nom de la société" },
      email: { type: "string", description: "Email principal (optionnel)" },
      phone_number: { type: "string", description: "Téléphone (optionnel)" },
      website: { type: "string", description: "Site web (optionnel)" },
      siret: { type: "string", description: "SIRET 14 chiffres (optionnel)" },
      type: { type: "string", enum: ["prospect", "client", "supplier", "partner"], description: "Type de société" },
      note: { type: "string", description: "Note libre (optionnel)" },
      confirmed: { type: "boolean", description: "true = créer, false = récapitulatif" }
    },
    required: ["name"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "create_company",
        data: params,
        message: `Récapitulatif de la société à créer :\n- Nom : ${params.name}\n- Type : ${params.type || "—"}\n- Email : ${params.email || "—"}\n- Site : ${params.website || "—"}\n\nDemande confirmation avant de créer.`
      };
    }
    try {
      const payload = { name: params.name };
      if (params.email) payload.email = params.email;
      if (params.phone_number) payload.phone_number = params.phone_number;
      if (params.website) payload.website = params.website;
      if (params.siret) payload.siret = params.siret;
      if (params.type) payload.type = params.type;
      if (params.note) payload.note = params.note;
      const result = await context.sellsyClient.createCompany(payload);
      return { status: "success", message: `Société "${params.name}" créée (ID: ${result.id}).`, data: result };
    } catch (err) {
      return { error: `Erreur lors de la création : ${err.message}` };
    }
  }
};

// ── Sellsy — Créer une opportunité ────────────────────

const sellsy_create_opportunity = {
  name: "sellsy_create_opportunity",
  description:
    "Crée une nouvelle opportunité/deal dans Sellsy. RÈGLE : présenter un récapitulatif avant de créer.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nom de l'opportunité" },
      amount: { type: "number", description: "Montant estimé (optionnel)" },
      probability: { type: "number", description: "Probabilité 0-100 (optionnel)" },
      pipeline_id: { type: "string", description: "ID du pipeline (optionnel)" },
      step_id: { type: "string", description: "ID de l'étape du pipeline (optionnel)" },
      company_id: { type: "string", description: "ID de la société liée (optionnel)" },
      contact_id: { type: "string", description: "ID du contact lié (optionnel)" },
      due_date: { type: "string", description: "Date de clôture YYYY-MM-DD (optionnel)" },
      note: { type: "string", description: "Note (optionnel)" },
      confirmed: { type: "boolean", description: "true = créer, false = récapitulatif" }
    },
    required: ["name"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "create_opportunity",
        data: params,
        message: `Récapitulatif de l'opportunité à créer :\n- Nom : ${params.name}\n- Montant : ${params.amount != null ? params.amount + " €" : "—"}\n- Probabilité : ${params.probability != null ? params.probability + "%" : "—"}\n- Date clôture : ${params.due_date || "—"}\n\nDemande confirmation avant de créer.`
      };
    }
    try {
      const payload = { name: params.name };
      if (params.amount != null) payload.amount = params.amount;
      if (params.probability != null) payload.probability = params.probability;
      if (params.pipeline_id) payload.pipeline_id = Number(params.pipeline_id);
      if (params.step_id) payload.step_id = Number(params.step_id);
      if (params.company_id) payload.company_id = Number(params.company_id);
      if (params.contact_id) payload.contact_ids = [Number(params.contact_id)];
      if (params.due_date) payload.due_date = params.due_date;
      if (params.note) payload.note = params.note;
      const result = await context.sellsyClient.createOpportunity(payload);
      return { status: "success", message: `Opportunité "${params.name}" créée (ID: ${result.id}).`, data: result };
    } catch (err) {
      return { error: `Erreur lors de la création : ${err.message}` };
    }
  }
};

// ── Sellsy — Créer un devis ───────────────────────────

const sellsy_create_quote = {
  name: "sellsy_create_quote",
  description:
    "Crée un nouveau devis/estimate dans Sellsy. RÈGLE : présenter les éléments avant de créer.",
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Objet/titre du devis" },
      company_id: { type: "string", description: "ID de la société cliente" },
      contact_id: { type: "string", description: "ID du contact (optionnel)" },
      opportunity_id: { type: "string", description: "ID de l'opportunité liée (optionnel)" },
      validity_date: { type: "string", description: "Date de validité YYYY-MM-DD (optionnel)" },
      note: { type: "string", description: "Note/commentaire (optionnel)" },
      confirmed: { type: "boolean", description: "true = créer, false = récapitulatif" }
    },
    required: ["subject", "company_id"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "create_quote",
        data: params,
        message: `Récapitulatif du devis à créer :\n- Objet : ${params.subject}\n- Société ID : ${params.company_id}\n- Validité : ${params.validity_date || "—"}\n\nDemande confirmation avant de créer.`
      };
    }
    try {
      const payload = { subject: params.subject, company_id: Number(params.company_id) };
      if (params.contact_id) payload.contact_id = Number(params.contact_id);
      if (params.opportunity_id) payload.related = { opportunity_id: Number(params.opportunity_id) };
      if (params.validity_date) payload.validity_date = params.validity_date;
      if (params.note) payload.note = params.note;
      const result = await context.sellsyClient.createQuote(payload);
      return { status: "success", message: `Devis "${params.subject}" créé (ID: ${result.id}).`, data: result };
    } catch (err) {
      return { error: `Erreur lors de la création : ${err.message}` };
    }
  }
};

// ── Sellsy — Mettre à jour un devis ──────────────────

const sellsy_update_quote = {
  name: "sellsy_update_quote",
  description:
    "Modifie un devis Sellsy existant (objet, note, date de validité, statut). RÈGLE CRITIQUE : afficher récapitulatif avant modification.",
  parameters: {
    type: "object",
    properties: {
      quote_id: { type: "string", description: "Identifiant du devis" },
      changes: {
        type: "object",
        description: "Champs à modifier",
        properties: {
          subject: { type: "string" },
          note: { type: "string" },
          validity_date: { type: "string" },
          status: { type: "string", enum: ["draft", "sent", "accepted", "refused", "cancelled"] }
        }
      },
      confirmed: { type: "boolean", description: "true uniquement après confirmation" }
    },
    required: ["quote_id", "changes"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "update_quote",
        quote_id: params.quote_id,
        changes: params.changes,
        message: `Récapitulatif modifications devis #${params.quote_id} :\n${Object.entries(params.changes).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\nDemande confirmation.`
      };
    }
    try {
      const updated = await context.sellsyClient.updateQuote(params.quote_id, params.changes);
      return { status: "success", message: `Devis #${params.quote_id} mis à jour.`, data: updated };
    } catch (err) {
      return { error: `Erreur lors de la mise à jour : ${err.message}` };
    }
  }
};

// ── Sellsy — Envoyer un devis par email ──────────────

const sellsy_send_quote = {
  name: "sellsy_send_quote",
  description:
    "Envoie un devis Sellsy par email au client. RÈGLE : demander confirmation avant l'envoi.",
  parameters: {
    type: "object",
    properties: {
      quote_id: { type: "string", description: "Identifiant du devis à envoyer" },
      to_email: { type: "string", description: "Adresse email du destinataire" },
      subject: { type: "string", description: "Objet de l'email (optionnel)" },
      message: { type: "string", description: "Corps du message (optionnel)" },
      confirmed: { type: "boolean", description: "true = envoyer, false = afficher récap" }
    },
    required: ["quote_id", "to_email"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        message: `Désirez-vous envoyer le devis #${params.quote_id} à ${params.to_email} ? Demande confirmation.`
      };
    }
    try {
      const emailPayload = { to: params.to_email };
      if (params.subject) emailPayload.subject = params.subject;
      if (params.message) emailPayload.message = params.message;
      await context.sellsyClient.sendQuote(params.quote_id, emailPayload);
      return { status: "success", message: `Devis #${params.quote_id} envoyé à ${params.to_email}.` };
    } catch (err) {
      return { error: `Erreur lors de l'envoi : ${err.message}` };
    }
  }
};

// ── Sellsy — Catalogue produits/services ─────────────

const sellsy_get_products = {
  name: "sellsy_get_products",
  description:
    "Recherche et liste les produits/services du catalogue Sellsy. Utile pour construire des devis ou factures.",
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "Terme de recherche (optionnel)" },
      limit: { type: "number", description: "Nombre max de résultats (défaut 25)" }
    },
    required: []
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    try {
      const filters = params.search ? { search: params.search } : {};
      const products = await context.sellsyClient.getProducts(filters, params.limit || 25);
      return products;
    } catch (err) {
      return { error: `Erreur catalogue produits : ${err.message}` };
    }
  }
};

// ── Sellsy — Créer une facture ───────────────────────

const sellsy_create_invoice = {
  name: "sellsy_create_invoice",
  description:
    "Crée une facture dans Sellsy liée à une société. RÈGLE : présenter récapitulatif et demander confirmation avant de créer.",
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Objet de la facture" },
      company_id: { type: "string", description: "ID de la société cliente" },
      contact_id: { type: "string", description: "ID du contact (optionnel)" },
      note: { type: "string", description: "Note (optionnel)" },
      due_date: { type: "string", description: "Date d'échéance YYYY-MM-DD (optionnel)" },
      confirmed: { type: "boolean", description: "true = créer, false = récapitulatif" }
    },
    required: ["subject", "company_id"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "create_invoice",
        data: params,
        message: `Récapitulatif facture à créer :\n- Objet : ${params.subject}\n- Société ID : ${params.company_id}\n- Échéance : ${params.due_date || "—"}\n\nDemande confirmation.`
      };
    }
    try {
      const payload = { subject: params.subject, company_id: Number(params.company_id) };
      if (params.contact_id) payload.contact_id = Number(params.contact_id);
      if (params.note) payload.note = params.note;
      if (params.due_date) payload.due_date = params.due_date;
      const result = await context.sellsyClient.createInvoice(payload);
      return { status: "success", message: `Facture "${params.subject}" créée (ID: ${result.id}).`, data: result };
    } catch (err) {
      return { error: `Erreur lors de la création : ${err.message}` };
    }
  }
};

// ── Sellsy — Envoyer une facture ─────────────────────

const sellsy_send_invoice = {
  name: "sellsy_send_invoice",
  description:
    "Envoie une facture Sellsy par email. RÈGLE : demander confirmation avant l'envoi.",
  parameters: {
    type: "object",
    properties: {
      invoice_id: { type: "string", description: "Identifiant de la facture" },
      to_email: { type: "string", description: "Adresse email du destinataire" },
      confirmed: { type: "boolean", description: "true = envoyer, false = afficher récap" }
    },
    required: ["invoice_id", "to_email"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return { status: "pending_confirmation", message: `Confirmer l'envoi de la facture #${params.invoice_id} à ${params.to_email} ?` };
    }
    try {
      await context.sellsyClient.sendInvoice(params.invoice_id, { to: params.to_email });
      return { status: "success", message: `Facture #${params.invoice_id} envoyée à ${params.to_email}.` };
    } catch (err) {
      return { error: `Erreur envoi facture : ${err.message}` };
    }
  }
};

// ── Sellsy — Tâches ───────────────────────────────────

const sellsy_get_tasks = {
  name: "sellsy_get_tasks",
  description:
    "Liste les tâches dans Sellsy avec filtres optionnels (assignée, liée à une entité, statut).",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Nombre max de résultats (défaut 25)" },
      status: { type: "string", enum: ["todo", "in_progress", "done"], description: "Filtrer par statut (optionnel)" }
    },
    required: []
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    try {
      const filters = {};
      if (params.status) filters.status = params.status;
      return await context.sellsyClient.getTasks(filters, params.limit || 25);
    } catch (err) {
      return { error: `Erreur lors de la récupération des tâches : ${err.message}` };
    }
  }
};

const sellsy_create_task = {
  name: "sellsy_create_task",
  description:
    "Crée une tâche dans Sellsy, optionnellement liée à une société/contact/opportunité.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Titre de la tâche" },
      description: { type: "string", description: "Description détaillée (optionnel)" },
      due_date: { type: "string", description: "Date d'échéance ISO 8601 (optionnel)" },
      priority: { type: "string", enum: ["low", "normal", "high"], description: "Priorité (optionnel)" },
      entity_type: { type: "string", enum: ["company", "contact", "opportunity"], description: "Type d'entité liée (optionnel)" },
      entity_id: { type: "string", description: "ID de l'entité liée (optionnel)" },
      confirmed: { type: "boolean", description: "true = créer, false = récapitulatif" }
    },
    required: ["title"]
  },
  async execute(params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        message: `Tâche à créer : "${params.title}"\n- Priorité : ${params.priority || "normal"}\n- Échéance : ${params.due_date || "—"}\n\nDemande confirmation.`
      };
    }
    try {
      const payload = { title: params.title };
      if (params.description) payload.description = params.description;
      if (params.due_date) payload.due_date = params.due_date;
      if (params.priority) payload.priority = params.priority;
      if (params.entity_type && params.entity_id) {
        payload.related = [{ type: params.entity_type, id: Number(params.entity_id) }];
      }
      const result = await context.sellsyClient.createSellsyTask(payload);
      return { status: "success", message: `Tâche "${params.title}" créée (ID: ${result.id}).`, data: result };
    } catch (err) {
      return { error: `Erreur création tâche : ${err.message}` };
    }
  }
};

// ── Sellsy — Stats CRM globales ───────────────────────

const sellsy_get_crm_stats = {
  name: "sellsy_get_crm_stats",
  description:
    "Retourne les statistiques globales du CRM Sellsy : nombre total de sociétés, contacts, opportunités, factures. Utile pour un bilan rapide.",
  parameters: {
    type: "object",
    properties: {},
    required: []
  },
  async execute(_params, context) {
    if (!context.sellsyClient) return { error: "Sellsy non connecté" };
    try {
      return await context.sellsyClient.getCRMStats();
    } catch (err) {
      return { error: `Erreur stats CRM : ${err.message}` };
    }
  }
};

// ── Admin — Stats plateforme Boatswain ─────────────────

const get_platform_stats = {
  name: "get_platform_stats",
  description:
    "Interroge la base de données de la plateforme Boatswain pour retourner des métriques réelles : nombre d'utilisateurs, workspaces actifs, conversations, tokens consommés (global, par workspace, par utilisateur), agents actifs, providers IA configurés. RÉSERVÉ ADMIN. Utilise cet outil pour répondre à toute question sur l'état de la plateforme.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["global", "users", "workspaces", "tokens", "agents", "conversations"],
        description: "Scope de données : 'global' (tout), 'users', 'workspaces', 'tokens', 'agents', 'conversations'"
      }
    },
    required: []
  },
  async execute(params, context) {
    if (!context.isAdmin) {
      return { error: "Accès refusé : cet outil est réservé aux administrateurs" };
    }
    try {
      const { prisma } = await import("../../prisma.js");
      const scope = params.scope || "global";

      // ── Utilisateurs ───────────────────────────────
      let usersData = null;
      if (scope === "global" || scope === "users") {
        const [totalUsers, byRole] = await Promise.all([
          prisma.user.count(),
          prisma.user.groupBy({ by: ["role"], _count: { id: true } })
        ]);
        usersData = {
          total: totalUsers,
          byRole: byRole.reduce((acc, r) => { acc[r.role] = r._count.id; return acc; }, {})
        };
      }

      // ── Workspaces ─────────────────────────────────
      let workspacesData = null;
      if (scope === "global" || scope === "workspaces") {
        const [total, active] = await Promise.all([
          prisma.workspace.count(),
          prisma.workspace.count({ where: { status: "active" } })
        ]);
        workspacesData = { total, active, inactive: total - active };
      }

      // ── Conversations ──────────────────────────────
      let conversationsData = null;
      if (scope === "global" || scope === "conversations") {
        const [total, last7d, last30d] = await Promise.all([
          prisma.conversation.count(),
          prisma.conversation.count({ where: { startedAt: { gte: new Date(Date.now() - 7 * 86400000) } } }),
          prisma.conversation.count({ where: { startedAt: { gte: new Date(Date.now() - 30 * 86400000) } } })
        ]);
        conversationsData = { total, last7Days: last7d, last30Days: last30d };
      }

      // ── Tokens ────────────────────────────────────
      let tokensData = null;
      if (scope === "global" || scope === "tokens") {
        const globalRow = await prisma.$queryRaw`
          SELECT COALESCE(SUM(tokens_input), 0)::int as input,
                 COALESCE(SUM(tokens_output), 0)::int as output,
                 COALESCE(SUM(tokens_input + tokens_output), 0)::int as total
          FROM messages WHERE role = 'assistant'`;

        const topUsers = await prisma.$queryRaw`
          SELECT u.email, u.role,
                 COALESCE(SUM(m.tokens_input + m.tokens_output), 0)::int as tokens
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          JOIN users u ON u.id = c.user_id
          WHERE m.role = 'assistant'
          GROUP BY u.id, u.email, u.role
          ORDER BY tokens DESC LIMIT 5`;

        const topWorkspaces = await prisma.$queryRaw`
          SELECT w.name, COALESCE(SUM(m.tokens_input + m.tokens_output), 0)::int as tokens
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          JOIN users u ON u.id = c.user_id
          JOIN workspaces w ON w.id = u.workspace_id
          WHERE m.role = 'assistant'
          GROUP BY w.id, w.name
          ORDER BY tokens DESC LIMIT 5`;

        tokensData = {
          global: {
            input: Number(globalRow[0]?.input || 0),
            output: Number(globalRow[0]?.output || 0),
            total: Number(globalRow[0]?.total || 0)
          },
          topUsers: topUsers.map(r => ({ email: r.email, role: r.role, tokens: Number(r.tokens) })),
          topWorkspaces: topWorkspaces.map(r => ({ workspace: r.name, tokens: Number(r.tokens) }))
        };
      }

      // ── Agents ──────────────────────────────────
      let agentsData = null;
      if (scope === "global" || scope === "agents") {
        const [total, active, global_agents] = await Promise.all([
          prisma.agent.count(),
          prisma.agent.count({ where: { isActive: true } }),
          prisma.agent.count({ where: { workspaceId: null, isActive: true } })
        ]);
        agentsData = { total, active, globalPlatform: global_agents, workspaceScoped: total - global_agents };
      }

      return {
        generatedAt: new Date().toISOString(),
        scope,
        users: usersData,
        workspaces: workspacesData,
        conversations: conversationsData,
        tokens: tokensData,
        agents: agentsData
      };
    } catch (err) {
      console.error("[get_platform_stats] Error:", err);
      return { error: `Erreur lors de la récupération des stats : ${err.message}` };
    }
  }
};

// ── File Processing Tools ─────────────────────────────

/**
 * Fire-and-forget: create/update the vault metadata note for an uploaded file.
 * Called after extraction so the agent gets the content immediately while the note is written async.
 * Only writes if no note exists yet (_vaultPath not set by pre-classification).
 */
async function _saveFileVaultNote(file, extractedText, context) {
  if (file._vaultPath) return; // already written by pre-classification
  if (!context.userId) return;
  try {
    const { classifyUploadedFile } = await import("../../services/classification/file-classifier.js");
    const user = { id: context.userId, email: context.userEmail };
    // Inject pre-extracted text so classifier doesn't re-extract
    const fileWithText = Object.assign(Object.create(Object.getPrototypeOf(file)), file);
    fileWithText._preExtractedText = extractedText;
    classifyUploadedFile({
      file: fileWithText,
      userId: context.userId,
      workspaceId: context.tenantId || null,
      conversationId: context.conversationId || null,
      agentId: context.agentId || null,
      user
    }).then((result) => {
      if (result) {
        file._vaultPath = result.vaultPath;
        file._classification = result.classification;
      }
    }).catch((err) => console.warn("[parse_tool] vault note creation failed:", err.message));
  } catch (err) {
    console.warn("[parse_tool] vault import failed:", err.message);
  }
}

const parse_pdf = {
  name: "parse_pdf",
  description:
    "Extrait le texte d'un fichier PDF uploadé. Utile pour analyser des documents, propositions, contrats.",
  parameters: {
    type: "object",
    properties: {
      file_index: {
        type: "number",
        description: "Index du fichier dans la liste des fichiers uploadés (commence à 0)"
      }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };
    if (!file.originalname?.toLowerCase().endsWith(".pdf") && file.mimetype !== "application/pdf") {
      return { error: "Le fichier n'est pas un PDF" };
    }

    // Reuse pre-classification OCR result for image-based PDFs
    if (file._extractedContent && file._classification) {
      try {
        const pdfParse = require("pdf-parse");
        const result = await pdfParse(file.buffer);
        if ((result.text || "").trim().length < 50) {
          return { filename: file.originalname, pages: result.numpages, text: file._extractedContent, ocrFallback: true, fromVaultNote: true };
        }
      } catch { /* fall through to normal parse */ }
    }

    try {
      const pdfParse = require("pdf-parse");
      const result = await pdfParse(file.buffer);
      const text = result.text || "";

      // Image-based PDF (no extractable text) → fallback to vision OCR
      if (text.trim().length < 50 && context.provider?.hasCapability("vision")) {
        try {
          const base64 = file.buffer.toString("base64");
          const ocrText = await context.provider.vision({
            base64,
            mediaType: "application/pdf",
            prompt: "Extrais tout le texte visible dans ce document PDF (OCR complet)."
          });
          const finalText = ocrText?.slice(0, 8000) || "";
          _saveFileVaultNote(file, finalText, context);
          return { filename: file.originalname, pages: result.numpages, text: finalText, ocrFallback: true, truncated: (ocrText?.length || 0) > 8000 };
        } catch {
          // OCR failed — return what we have
        }
      }

      const finalText = text.slice(0, 8000);
      _saveFileVaultNote(file, finalText, context);
      return {
        filename: file.originalname,
        pages: result.numpages,
        text: finalText,
        truncated: text.length > 8000
      };
    } catch (error) {
      return { error: `Erreur parsing PDF: ${error.message}` };
    }
  }
};

const parse_csv = {
  name: "parse_csv",
  description:
    "Parse un fichier CSV uploadé et retourne les données structurées (en-têtes + lignes).",
  parameters: {
    type: "object",
    properties: {
      file_index: {
        type: "number",
        description: "Index du fichier uploadé (commence à 0)"
      },
      max_rows: {
        type: "number",
        description: "Nombre max de lignes à retourner (défaut 100)"
      }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };

    try {
      const Papa = require("papaparse");
      const csvText = file.buffer.toString("utf-8");
      const result = Papa.parse(csvText, { header: true, skipEmptyLines: true });

      const maxRows = params.max_rows || 100;
      const preview = result.data?.slice(0, maxRows).map(r => Object.values(r).join(",")).join("\n");
      _saveFileVaultNote(file, preview || csvText.slice(0, 4000), context);
      return {
        filename: file.originalname,
        headers: result.meta?.fields || [],
        totalRows: result.data?.length || 0,
        rows: result.data?.slice(0, maxRows),
        truncated: (result.data?.length || 0) > maxRows,
        errors: result.errors?.slice(0, 5)
      };
    } catch (error) {
      return { error: `Erreur parsing CSV: ${error.message}` };
    }
  }
};

const parse_excel = {
  name: "parse_excel",
  description:
    "Parse un fichier Excel (.xlsx, .xls) uploadé et retourne les données structurées par feuille.",
  parameters: {
    type: "object",
    properties: {
      file_index: {
        type: "number",
        description: "Index du fichier uploadé (commence à 0)"
      },
      sheet_name: {
        type: "string",
        description: "Nom de la feuille (optionnel, première feuille par défaut)"
      },
      max_rows: {
        type: "number",
        description: "Nombre max de lignes (défaut 100)"
      }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };

    try {
      const XLSX = require("xlsx");
      const workbook = XLSX.read(file.buffer, { type: "buffer" });

      const sheetName = params.sheet_name || workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        return {
          error: `Feuille "${sheetName}" introuvable. Feuilles disponibles: ${workbook.SheetNames.join(", ")}`
        };
      }

      const data = XLSX.utils.sheet_to_json(sheet);
      const maxRows = params.max_rows || 100;
      const preview = XLSX.utils.sheet_to_csv(sheet).slice(0, 4000);
      _saveFileVaultNote(file, preview, context);
      return {
        filename: file.originalname,
        sheetNames: workbook.SheetNames,
        currentSheet: sheetName,
        headers: data.length > 0 ? Object.keys(data[0]) : [],
        totalRows: data.length,
        rows: data.slice(0, maxRows),
        truncated: data.length > maxRows
      };
    } catch (error) {
      return { error: `Erreur parsing Excel: ${error.message}` };
    }
  }
};

const parse_word = {
  name: "parse_word",
  description:
    "Extrait le texte d'un fichier Word (.docx) uploadé.",
  parameters: {
    type: "object",
    properties: {
      file_index: {
        type: "number",
        description: "Index du fichier uploadé (commence à 0)"
      }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };

    try {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      const text = result.value?.slice(0, 8000) || "";
      _saveFileVaultNote(file, text, context);
      return {
        filename: file.originalname,
        text,
        truncated: (result.value?.length || 0) > 8000,
        warnings: result.messages?.filter((m) => m.type === "warning").map((m) => m.message).slice(0, 5)
      };
    } catch (error) {
      return { error: `Erreur parsing Word: ${error.message}` };
    }
  }
};

const parse_powerpoint = {
  name: "parse_powerpoint",
  description: "Extrait le texte d'un fichier PowerPoint (PPTX/PPT) uploadé, slide par slide.",
  parameters: {
    type: "object",
    properties: {
      file_index: { type: "number", description: "Index du fichier uploadé (commence à 0)" }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };
    try {
      const { parseOffice } = await import("officeparser");
      const text = await parseOffice(file.buffer);
      const finalText = text?.slice(0, 10000) || "";
      _saveFileVaultNote(file, finalText, context);
      return { filename: file.originalname, text: finalText, truncated: (text?.length || 0) > 10000 };
    } catch (error) {
      return { error: `Erreur parsing PowerPoint: ${error.message}` };
    }
  }
};

const parse_opendocument = {
  name: "parse_opendocument",
  description: "Extrait le texte d'un fichier OpenDocument (ODT Writer, ODS Calc, ODP Présentation) uploadé.",
  parameters: {
    type: "object",
    properties: {
      file_index: { type: "number", description: "Index du fichier uploadé (commence à 0)" }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };
    try {
      const { parseOffice } = await import("officeparser");
      const text = await parseOffice(file.buffer);
      const finalText = text?.slice(0, 10000) || "";
      _saveFileVaultNote(file, finalText, context);
      return { filename: file.originalname, text: finalText, truncated: (text?.length || 0) > 10000 };
    } catch (error) {
      return { error: `Erreur parsing OpenDocument: ${error.message}` };
    }
  }
};

const parse_text = {
  name: "parse_text",
  description: "Lit le contenu d'un fichier texte brut (.txt, .md) uploadé.",
  parameters: {
    type: "object",
    properties: {
      file_index: { type: "number", description: "Index du fichier uploadé (commence à 0)" }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };
    try {
      const text = file.buffer.toString("utf-8");
      _saveFileVaultNote(file, text.slice(0, 4000), context);
      return { filename: file.originalname, text: text.slice(0, 10000), truncated: text.length > 10000 };
    } catch (error) {
      return { error: `Erreur lecture fichier texte: ${error.message}` };
    }
  }
};

const parse_json = {
  name: "parse_json",
  description: "Parse et formate un fichier JSON uploadé pour l'analyse.",
  parameters: {
    type: "object",
    properties: {
      file_index: { type: "number", description: "Index du fichier uploadé (commence à 0)" }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };
    try {
      const text = file.buffer.toString("utf-8");
      const parsed = JSON.parse(text);
      const preview = JSON.stringify(parsed, null, 2);
      _saveFileVaultNote(file, text.slice(0, 4000), context);
      return { filename: file.originalname, data: parsed, preview: preview.slice(0, 8000), truncated: preview.length > 8000 };
    } catch (error) {
      return { error: `Erreur parsing JSON: ${error.message}` };
    }
  }
};

const parse_image = {
  name: "parse_image",
  description: "Analyse une image uploadée via un modèle IA vision : extrait le texte (OCR) et décrit le contenu visuellement. Nécessite un provider avec la capacité 'vision' activée.",
  parameters: {
    type: "object",
    properties: {
      file_index: { type: "number", description: "Index du fichier uploadé (commence à 0)" },
      prompt: { type: "string", description: "Question spécifique sur l'image, ex: 'Extrais tout le texte visible' (optionnel)" }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };

    // Reuse pre-classification result to avoid duplicate vision API call
    if (file._extractedContent && !params.prompt) {
      return {
        filename: file.originalname,
        description: file._extractedContent,
        fromVaultNote: true,
        classification: file._classification || undefined
      };
    }

    if (!context.provider) return { error: "Provider IA non disponible dans ce contexte" };
    if (!context.provider.hasCapability("vision")) {
      return { error: "Le provider actuel ne supporte pas la vision. Activez la capacité 'vision' dans les paramètres du provider IA." };
    }
    try {
      const base64 = file.buffer.toString("base64");
      const description = await context.provider.vision({
        base64,
        mediaType: file.mimetype,
        prompt: params.prompt || "Décris cette image en détail et extrais tout le texte visible (OCR)."
      });
      _saveFileVaultNote(file, description || "", context);
      return { filename: file.originalname, description };
    } catch (error) {
      return { error: `Erreur analyse image: ${error.message}` };
    }
  }
};

const parse_audio = {
  name: "parse_audio",
  description: "Transcrit un fichier audio uploadé en texte via Whisper. Nécessite un provider avec la capacité 'audio' activée (OpenAI).",
  parameters: {
    type: "object",
    properties: {
      file_index: { type: "number", description: "Index du fichier uploadé (commence à 0)" }
    },
    required: ["file_index"]
  },
  async execute(params, context) {
    const file = context.uploadedFiles?.[params.file_index];
    if (!file) return { error: "Fichier non trouvé à l'index spécifié" };

    // Reuse pre-classification result to avoid duplicate audio transcription API call
    if (file._extractedContent) {
      return {
        filename: file.originalname,
        transcription: file._extractedContent,
        fromVaultNote: true,
        classification: file._classification || undefined
      };
    }

    if (!context.provider) return { error: "Provider IA non disponible dans ce contexte" };
    if (!context.provider.hasCapability("audio")) {
      return { error: "Le provider actuel ne supporte pas la transcription audio. Activez la capacité 'audio' dans les paramètres du provider IA (OpenAI uniquement)." };
    }
    try {
      const transcription = await context.provider.audio({ buffer: file.buffer, mimeType: file.mimetype });
      _saveFileVaultNote(file, transcription || "", context);
      return { filename: file.originalname, transcription };
    } catch (error) {
      return { error: `Erreur transcription audio: ${error.message}` };
    }
  }
};

// ── Reminder Tool ────────────────────────────────────

const PRIVATE_VISIBILITY_MARKER = "[PRIVATE] ";

function applyVisibilityPrefix(text, visibility) {
  const clean = String(text || "").replace(/^\[PRIVATE\]\s*/i, "").trim();
  if (visibility === "private") {
    return clean ? `${PRIVATE_VISIBILITY_MARKER}${clean}` : PRIVATE_VISIBILITY_MARKER.trim();
  }
  return clean;
}

function normalizeReminderChannel(rawChannel) {
  const value = String(rawChannel || "").trim().toLowerCase();
  if (!value) return null;
  if (["chat", "in-app", "in app", "app"].includes(value)) return "chat";
  if (["email", "mail", "e-mail"].includes(value)) return "email";
  if (["whatsapp", "wa", "wpp"].includes(value)) return "whatsapp";
  if (["push", "push_notif", "push notif", "push_notification", "notification", "notif"].includes(value)) return "push";
  return null;
}

/**
 * Tool permettant aux agents IA de planifier un rappel pour l'utilisateur.
 *
 * L'agent doit :
 *   RÈGLE CRITIQUE (même pattern que sellsy_update_opportunity) :
 *   1. Appeler ce tool SANS `confirmed: true` pour générer un récapitulatif à soumettre à l'utilisateur.
 *   2. Appeler ce tool avec `confirmed: true` UNIQUEMENT après confirmation explicite de l'utilisateur.
 *   3. Convertir la date du fuseau horaire de l'utilisateur en UTC avant d'appeler ce tool.
 *
 * Ce tool a besoin de context.userId (injecté par le dispatcher via toolContext).
 */
const schedule_reminder = {
  name: "schedule_reminder",
  description:
    "Planifie un rappel ou une tâche pour l'utilisateur à une date et heure précises. " +
    "RÈGLE CRITIQUE : appelle d'abord ce tool SANS `confirmed: true` pour présenter un récapitulatif " +
    "à l'utilisateur (date, heure, action, canal). Appelle-le ensuite avec `confirmed: true` " +
    "UNIQUEMENT après confirmation explicite de l'utilisateur. " +
    "IMPORTANT : convertis toujours la date exprimée dans le fuseau horaire de l'utilisateur en UTC.",
  parameters: {
    type: "object",
    properties: {
      task_description: {
        type: "string",
        description: "Description claire du rappel ou de la tâche (ex: 'Relancer le client Dupont pour le devis')"
      },
      scheduled_at: {
        type: "string",
        description: "Date et heure en UTC, format ISO 8601 (ex: '2026-04-15T09:00:00Z'). Utilise TOUJOURS une date future basée sur la date actuelle fournie dans le contexte système."
      },
      channel: {
        type: "string",
        enum: ["chat", "email", "push", "whatsapp"],
        description: "Canal de livraison : 'chat', 'email', 'push' (notification in-app) ou 'whatsapp'."
      },
      target_phone: {
        type: "string",
        description: "Numéro WhatsApp au format E.164 (ex: '+33612345678'). Requis seulement si channel='whatsapp'."
      },
      target_email: {
        type: "string",
        description: "Adresse email cible. Requis seulement si channel='email'."
      },
      timezone: {
        type: "string",
        description: "Fuseau horaire de l'utilisateur (ex: 'Europe/Paris'). Utilisé pour l'affichage dans le récapitulatif."
      },
      visibility: {
        type: "string",
        enum: ["public", "private"],
        description: "Visibilité de la tâche créée dans le workspace. 'public' = visible dans le workspace, 'private' = réservé aux admins (plateforme/workspace)."
      },
      confirmed: {
        type: "boolean",
        description: "Mettre à true UNIQUEMENT après confirmation explicite de l'utilisateur. Ne pas inclure ou laisser false pour le premier appel (récapitulatif)."
      }
    },
    required: ["task_description", "scheduled_at"]
  },
  async execute(params, context) {
    const userId = context.userId;
    if (!userId) {
      return { error: "Impossible de planifier le rappel : userId manquant dans le contexte" };
    }

    // Validation de la date (commune aux deux phases)
    const scheduledDate = new Date(params.scheduled_at);
    if (isNaN(scheduledDate.getTime())) {
      return { error: "Format de date invalide. Utilisez le format ISO 8601 UTC (ex: '2025-03-25T09:00:00Z')" };
    }

    if (scheduledDate < new Date(Date.now() - 60_000)) {
      return { error: "La date de rappel ne peut pas être dans le passé" };
    }

    const timezone = params.timezone || "Europe/Paris";
    const visibility = params.visibility === "private" ? "private" : "public";

    // Formate la date dans le fuseau horaire de l'utilisateur pour l'affichage
    const formattedDate = scheduledDate.toLocaleString("fr-FR", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "short",
    });

    const channel = normalizeReminderChannel(params.channel);

    if (!channel) {
      return {
        status: "pending_channel",
        action: "schedule_reminder",
        task_description: params.task_description,
        scheduled_at: params.scheduled_at,
        formatted_date: formattedDate,
        message:
          `INSTRUCTION : Appelle immédiatement le tool ask_user avec :\n` +
          `  question: "Par quel canal souhaitez-vous recevoir ce rappel ?"\n` +
          `  suggestions: ["Chat", "Email", "Push notif", "WhatsApp"]\n` +
          `  context: "Rappel prévu le ${formattedDate} — ${params.task_description}"\n` +
          `Ensuite, rappelle schedule_reminder avec le canal choisi.`
      };
    }

    if (channel === "whatsapp" && !params.target_phone) {
      return { error: "target_phone est requis pour le canal whatsapp" };
    }
    if (channel === "email" && !params.target_email) {
      return { error: "target_email est requis pour le canal email" };
    }

    const channelLabel = channel === "whatsapp"
      ? `WhatsApp (${params.target_phone})`
      : channel === "email"
      ? `Email (${params.target_email})`
      : channel === "push"
      ? "push notification (in-app)"
      : "notification dans la plateforme";

    // ── Phase 1 : Récapitulatif + demande de confirmation via ask_user ─
    // Premier appel (sans confirmed: true) → on demande à l'agent d'appeler
    // ask_user avec les suggestions "Valider", "Modifier", "Annuler".
    if (params.confirmed !== true) {
      return {
        status: "pending_confirmation",
        action: "schedule_reminder",
        task_description: params.task_description,
        scheduled_at: params.scheduled_at,
        formatted_date: formattedDate,
        channel,
        target_phone: params.target_phone || null,
        // L'instruction indique à l'agent d'enchaîner immédiatement avec ask_user
        message:
          `Récapitulatif du rappel à planifier :\n` +
          `- 📋 Tâche : ${params.task_description}\n` +
          `- 📅 Date / heure : ${formattedDate}\n` +
          `- 📣 Canal : ${channelLabel}\n\n` +
          `- 🔒 Visibilité : ${visibility === "private" ? "Privée" : "Publique"}\n\n` +
          `INSTRUCTION : Appelle immédiatement le tool ask_user avec :\n` +
          `  question: "Souhaitez-vous confirmer la planification de ce rappel ?"\n` +
          `  suggestions: ["Valider", "Modifier", "Annuler"]\n` +
          `  context: "Rappel prévu le ${formattedDate} — ${params.task_description}"\n` +
          `N'écris PAS de réponse texte avant d'avoir appelé ask_user. ` +
          `Si l'utilisateur répond "Valider", rappelle schedule_reminder avec confirmed=true. ` +
          `Si "Modifier", demande ce qu'il souhaite changer puis rappelle schedule_reminder sans confirmed. ` +
          `Si "Annuler", confirme l'annulation sans créer le rappel.`
      };
    }

    // ── Phase 2 : Création en base après confirmation ───────────────
    try {
      const { prisma } = await import("../../prisma.js");

      const workspaceId = context.tenantId || null;

      const reminder = await prisma.reminder.create({
        data: {
          userId,
          agentId: context.agentId || null,
          workspaceId,
          taskDescription: params.task_description,
          scheduledAt: scheduledDate,
          timezone,
          status: "PENDING",
          // DB enum does not include "push" yet; push reminders are delivered via in-app SSE like chat.
          channel: channel === "push" ? "chat" : channel,
          targetPhone: params.target_phone || null,
          targetEmail: params.target_email || null,
        },
      });

      let task = null;
      if (workspaceId) {
        const taskDescription = applyVisibilityPrefix(
          `Rappel planifié le ${formattedDate} via ${channelLabel}`,
          visibility
        );

        task = await prisma.taskAssignment.create({
          data: {
            userId,
            workspaceId,
            title: params.task_description,
            description: taskDescription,
            dueDate: scheduledDate,
            entityType: "reminder",
            entityId: String(reminder.id),
            status: "pending",
            priority: "medium",
          },
        });
      }

      return {
        status: "scheduled",
        reminderId: reminder.id,
        taskId: task?.id || null,
        visibility,
        scheduledAt: reminder.scheduledAt,
        channel,
        message: task
          ? `✅ Rappel confirmé et planifié ! Je vous rappellerai le ${formattedDate} : "${params.task_description}". (Rappel #${reminder.id}, Tâche #${task.id})`
          : `✅ Rappel confirmé et planifié ! Je vous rappellerai le ${formattedDate} : "${params.task_description}". (Rappel #${reminder.id})`
      };
    } catch (err) {
      console.error("[schedule_reminder tool] Erreur:", err);
      return { error: `Erreur lors de la création du rappel : ${err.message}` };
    }
  }
};

// ── Email Tool ────────────────────────────────────────

const send_email = {
  name: "send_email",
  description:
    "Compose et envoie un email au nom de l'utilisateur. IMPORTANT : utilise d'abord ask_user pour montrer un aperçu de l'email (destinataire, objet, corps) et demander confirmation avant d'envoyer.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Adresse email du destinataire"
      },
      cc: {
        type: "string",
        description: "Adresse en copie (optionnel)"
      },
      subject: {
        type: "string",
        description: "Objet de l'email"
      },
      body: {
        type: "string",
        description: "Corps de l'email en texte brut ou HTML"
      },
      confirmed: {
        type: "boolean",
        description: "true = envoyer directement, false/absent = montrer l'aperçu d'abord"
      }
    },
    required: ["to", "subject", "body"]
  },
  async execute(params, context) {
    if (!context.userId) {
      return { error: "Contexte utilisateur manquant" };
    }

    if (!params.confirmed) {
      return {
        status: "preview",
        preview: {
          to: params.to,
          cc: params.cc || null,
          subject: params.subject,
          body: params.body,
        },
        message: `📧 Aperçu de l'email :\n\n**À :** ${params.to}\n**Objet :** ${params.subject}\n\n${params.body}\n\nConfirmez-vous l'envoi ?`,
      };
    }

    try {
      const { sendEmail } = await import("../../services/email/email-service.js");
      await sendEmail({
        userId: context.userId,
        workspaceId: context.tenantId || null,
        to: params.to,
        cc: params.cc,
        subject: params.subject,
        html: params.body,
      });
      return {
        status: "sent",
        message: `Email envoyé à ${params.to} avec succès.`,
      };
    } catch (err) {
      console.error("[send_email tool] Erreur:", err);
      return { error: `Erreur lors de l'envoi : ${err.message}` };
    }
  }
};

// ── Calendar Tool ─────────────────────────────────────

const create_calendar_event = {
  name: "create_calendar_event",
  description:
    "Crée un événement dans le calendrier de l'utilisateur. Utilise cet outil quand l'utilisateur demande de planifier une réunion, un rendez-vous ou un événement.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Titre de l'événement"
      },
      description: {
        type: "string",
        description: "Description ou notes pour cet événement (optionnel)"
      },
      start_at: {
        type: "string",
        description: "Date et heure de début en ISO 8601 UTC, ex: '2026-04-15T09:00:00Z'. Utilise TOUJOURS une date future basée sur la date actuelle fournie dans le contexte."
      },
      end_at: {
        type: "string",
        description: "Date et heure de fin en ISO 8601 UTC, ex: '2026-04-15T10:00:00Z'. Doit être postérieure à start_at."
      },
      timezone: {
        type: "string",
        description: "Fuseau horaire de l'utilisateur, ex: 'Europe/Paris' (défaut)"
      },
      location: {
        type: "string",
        description: "Lieu de l'événement (optionnel)"
      },
      visibility: {
        type: "string",
        enum: ["public", "private"],
        description: "Visibilité de l'événement dans le workspace. 'public' = visible workspace, 'private' = réservé aux admins."
      }
    },
    required: ["title", "start_at", "end_at"]
  },
  async execute(params, context) {
    if (!context.userId) {
      return { error: "Contexte utilisateur manquant" };
    }

    const startAt = new Date(params.start_at);
    const endAt = new Date(params.end_at);
    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
      return { error: "Dates invalides pour l'événement" };
    }
    if (endAt <= startAt) {
      return { error: "La date de fin doit être postérieure à la date de début" };
    }

    const visibility = params.visibility === "private" ? "private" : "public";
    const storedDescription = applyVisibilityPrefix(params.description ?? "", visibility) || null;

    try {
      const { prisma } = await import("../../prisma.js");
      const event = await prisma.calendarEvent.create({
        data: {
          userId:      context.userId,
          workspaceId: context.tenantId || null,
          title:       params.title,
          description: storedDescription,
          startAt,
          endAt,
          timezone:    params.timezone ?? "Europe/Paris",
          location:    params.location ?? null,
        },
      });
      return {
        status: "created",
        eventId: event.id,
        visibility,
        message: `Événement "${params.title}" créé le ${new Date(params.start_at).toLocaleString("fr-FR", { timeZone: params.timezone || "Europe/Paris" })}.`,
      };
    } catch (err) {
      console.error("[create_calendar_event tool] Erreur:", err);
      return { error: `Erreur lors de la création : ${err.message}` };
    }
  }
};

// ── CRM Phase 3 Tools ──────────────────────────────────

const enrich_company_data = {
  name: "enrich_company_data",
  description:
    "Enrichit les données d'une entreprise via son SIRET (INSEE SIRENE). Retourne données complètes : secteur, effectifs, CA, date création, etc.",
  parameters: {
    type: "object",
    properties: {
      siret: {
        type: "string",
        description: "SIRET de l'entreprise (14 chiffres), ex: '12345678901234'"
      }
    },
    required: ["siret"]
  },
  async execute(params, context) {
    if (!context.userId || !context.tenantId) {
      return { error: "Contexte utilisateur manquant" };
    }
    if (!/^\d{14}$/.test(params.siret)) {
      return { error: "SIRET invalide (doit contenir 14 chiffres)" };
    }

    try {
      const { prisma } = await import("../../prisma.js");
      // Créer ou récupérer job d'enrichissement
      let enriched = await prisma.siretEnrichment.findUnique({
        where: { siret: params.siret }
      });

      if (!enriched) {
        enriched = await prisma.siretEnrichment.create({
          data: {
            userId: context.userId,
            tenantId: context.tenantId,
            siret: params.siret,
            status: "pending",
          }
        });
      }

      return {
        status: enriched.status,
        siret: enriched.siret,
        company: enriched.company || "Données en cours de récupération...",
        message: enriched.status === "completed"
          ? `Données d'enrichissement disponibles pour ${enriched.company}`
          : "Enrichissement en cours, veuillez réessayer dans quelques secondes"
      };
    } catch (err) {
      console.error("[enrich_company_data tool] Erreur:", err);
      return { error: `Erreur lors de l'enrichissement : ${err.message}` };
    }
  }
};

const create_task = {
  name: "create_task",
  description:
    "Crée une tâche assignée à un utilisateur, optionnellement liée à une entreprise/contact/opportunité.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Titre de la tâche"
      },
      description: {
        type: "string",
        description: "Description détaillée (optionnel)"
      },
      due_date: {
        type: "string",
        description: "Date d'échéance ISO 8601, ex: '2025-04-15T09:00:00Z' (optionnel)"
      },
      priority: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Priorité de la tâche"
      },
      visibility: {
        type: "string",
        enum: ["public", "private"],
        description: "Visibilité de la tâche dans le workspace. 'public' = visible workspace, 'private' = réservé aux admins."
      },
      entity_type: {
        type: "string",
        description: "Type d'entité liée : 'company', 'contact', 'opportunity' (optionnel)"
      },
      entity_id: {
        type: "string",
        description: "ID de l'entité liée (optionnel)"
      }
    },
    required: ["title"]
  },
  async execute(params, context) {
    if (!context.userId || !context.tenantId) {
      return { error: "Contexte utilisateur manquant" };
    }

    try {
      const { prisma } = await import("../../prisma.js");
      const visibility = params.visibility === "private" ? "private" : "public";
      const storedDescription = applyVisibilityPrefix(params.description || "", visibility) || null;
      const task = await prisma.taskAssignment.create({
        data: {
          userId: context.userId,
          workspaceId: context.tenantId,
          title: params.title,
          description: storedDescription,
          dueDate: params.due_date ? new Date(params.due_date) : null,
          priority: params.priority || "medium",
          entityType: params.entity_type || null,
          entityId: params.entity_id || null,
          status: "pending",
        }
      });
      return {
        status: "created",
        taskId: task.id,
        visibility,
        message: `Tâche créée: "${params.title}" (ID: ${task.id})`
      };
    } catch (err) {
      console.error("[create_task tool] Erreur:", err);
      return { error: `Erreur lors de la création : ${err.message}` };
    }
  }
};

// ── Report Generation Tool ────────────────────────────

const generate_report = {
  name: "generate_report",
  description:
    "Genere un rapport PDF professionnel a partir de contenu markdown. Retourne un lien de telechargement. Utilise cet outil quand l'utilisateur demande un rapport, un document, un export ou un PDF.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Le contenu du rapport en markdown (titres, listes, texte)"
      },
      title: {
        type: "string",
        description: "Titre du rapport (ex: 'Rapport Pipeline Q1 2025')"
      },
      subtitle: {
        type: "string",
        description: "Sous-titre optionnel"
      }
    },
    required: ["content", "title"]
  },
  async execute(params) {
    try {
      const { generatePDF } = await import("../documents/pdf-generator.js");
      const result = await generatePDF({
        content: params.content,
        title: params.title,
        subtitle: params.subtitle || ""
      });
      return {
        status: "success",
        fileId: result.fileId,
        filename: result.filename,
        downloadUrl: `/api/chat/download/${result.fileId}`,
        message: `Rapport genere : "${params.title}". Lien de telechargement : /api/chat/download/${result.fileId}`
      };
    } catch (error) {
      return { error: `Erreur generation PDF: ${error.message}` };
    }
  }
};

// ── Tool Domain Subsets (for sub-agents) ─────────────

export const FILE_TOOLS = [parse_pdf, parse_csv, parse_excel, parse_word, parse_powerpoint, parse_opendocument, parse_json, parse_text, parse_image, parse_audio];

export const SELLSY_TOOLS = [
  // Read
  sellsy_get_company, sellsy_get_contact, sellsy_get_opportunity,
  sellsy_search_companies, sellsy_search_contacts, sellsy_get_pipeline,
  sellsy_get_activities, sellsy_get_invoices, sellsy_get_quote,
  sellsy_get_opportunities, sellsy_get_products, sellsy_get_tasks,
  sellsy_get_crm_stats, sellsy_global_search,
  // Write
  sellsy_update_opportunity, sellsy_update_company, sellsy_update_contact,
  sellsy_update_quote, sellsy_create_note,
  sellsy_create_contact, sellsy_create_company, sellsy_create_opportunity,
  sellsy_create_quote, sellsy_send_quote,
  sellsy_create_invoice, sellsy_send_invoice,
  sellsy_create_task,
];

export const WEB_TOOLS = [web_search, web_scrape];

export const INTERACTION_TOOLS = [ask_user, navigate_to];

export const ADMIN_TOOLS = [get_platform_stats];

// ── Vault Tools ───────────────────────────────────────

const VAULT_BASE = process.env.VAULT_BASE_PATH || resolve("./vaults");
const VAULT_GLOBAL_DIR = "Global";
const VAULT_WORKSPACES_DIR = "Workspaces";
const VAULT_SYSTEM_DIR = "System";
const VAULT_FOLDER_OWNERS_FILE = ".folder-owners.json";
const VAULT_USER_VISIBILITY_FILE = ".user-folders.json";
const VAULT_AI_SHARING_FILE = ".ai-folder-sharing.json";

function normalizeVaultToolPath(rawPath = "") {
  return String(rawPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function toWorkspaceRootPath(workspaceId, notePath = "") {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const normalizedNotePath = normalizeVaultToolPath(notePath);
  if (!normalizedWorkspaceId) return "";
  if (!normalizedNotePath) return `${VAULT_WORKSPACES_DIR}/${normalizedWorkspaceId}`;
  return `${VAULT_WORKSPACES_DIR}/${normalizedWorkspaceId}/${normalizedNotePath}`;
}

function parseVaultScopedPath(rawPath = "", defaultWorkspaceId = null) {
  const normalizedPath = normalizeVaultToolPath(rawPath);
  const normalizedDefaultWorkspaceId = String(defaultWorkspaceId || "").trim();

  if (!normalizedPath) {
    return {
      scope: normalizedDefaultWorkspaceId ? "workspace" : "root",
      workspaceId: normalizedDefaultWorkspaceId || null,
      notePath: "",
      rootPath: normalizedDefaultWorkspaceId
        ? toWorkspaceRootPath(normalizedDefaultWorkspaceId)
        : "",
      isRootScoped: false,
    };
  }

  if (normalizedPath === VAULT_GLOBAL_DIR || normalizedPath.startsWith(`${VAULT_GLOBAL_DIR}/`)) {
    return {
      scope: "global",
      workspaceId: null,
      notePath: normalizedPath.slice(VAULT_GLOBAL_DIR.length).replace(/^\//, ""),
      rootPath: normalizedPath,
      isRootScoped: true,
    };
  }

  if (normalizedPath === VAULT_WORKSPACES_DIR || normalizedPath.startsWith(`${VAULT_WORKSPACES_DIR}/`)) {
    const parts = normalizedPath.split("/");
    const workspaceId = String(parts[1] || "").trim() || null;
    const notePath = normalizeVaultToolPath(parts.slice(2).join("/"));
    return {
      scope: "workspace",
      workspaceId,
      notePath,
      rootPath: workspaceId ? toWorkspaceRootPath(workspaceId, notePath) : VAULT_WORKSPACES_DIR,
      isRootScoped: true,
    };
  }

  if (!normalizedDefaultWorkspaceId) {
    return {
      scope: "workspace",
      workspaceId: null,
      notePath: normalizedPath,
      rootPath: normalizedPath,
      isRootScoped: false,
    };
  }

  return {
    scope: "workspace",
    workspaceId: normalizedDefaultWorkspaceId,
    notePath: normalizedPath,
    rootPath: toWorkspaceRootPath(normalizedDefaultWorkspaceId, normalizedPath),
    isRootScoped: false,
  };
}

function topLevelFolder(pathValue = "") {
  return normalizeVaultToolPath(pathValue).split("/")[0] || "";
}

function normalizeOwnerId(value) {
  return String(value || "").trim();
}

function extractTopLevelOwnerId(pathValue = "") {
  const topLevel = topLevelFolder(pathValue);
  if (!topLevel) return null;
  return /^\d+$/.test(topLevel) ? topLevel : null;
}

function getNearestPathMapValue(map, pathValue) {
  const normalizedPath = normalizeVaultToolPath(pathValue);
  if (!normalizedPath) return null;

  const parts = normalizedPath.split("/");
  for (let i = parts.length; i > 0; i -= 1) {
    const key = parts.slice(0, i).join("/");
    if (key in map) return map[key];
  }

  return null;
}

function normalizeAiShareMode(rawMode) {
  const mode = String(rawMode || "").trim().toLowerCase();
  if (["shared_full", "full", "public_full", "workspace_full", "vertical"].includes(mode)) {
    return "shared_full";
  }
  if (["shared", "upward", "public"].includes(mode)) {
    return "shared";
  }
  return "owner_only";
}

async function pathExists(pathValue) {
  try {
    await fs.access(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceVaultRoot(workspaceId) {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const modernRoot = join(VAULT_BASE, VAULT_WORKSPACES_DIR, normalizedWorkspaceId);
  const legacyRoot = join(VAULT_BASE, normalizedWorkspaceId);

  if (await pathExists(modernRoot)) return modernRoot;
  if (await pathExists(legacyRoot)) return legacyRoot;
  return modernRoot;
}

async function readWorkspaceVaultMap(workspaceId, fileName) {
  const root = await resolveWorkspaceVaultRoot(workspaceId);
  const filePath = join(root, fileName);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

async function isWorkspaceAncestor(prisma, ancestorWorkspaceId, workspaceId, parentCache) {
  const normalizedAncestor = String(ancestorWorkspaceId || "").trim();
  const normalizedWorkspace = String(workspaceId || "").trim();
  if (!normalizedAncestor || !normalizedWorkspace || normalizedAncestor === normalizedWorkspace) {
    return false;
  }

  let current = normalizedWorkspace;
  while (current) {
    if (current === normalizedAncestor) return true;

    if (parentCache.has(current)) {
      current = parentCache.get(current);
      continue;
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: current },
      select: { parentWorkspaceId: true },
    });

    const parentId = workspace?.parentWorkspaceId || null;
    parentCache.set(current, parentId);
    current = parentId;
  }

  return false;
}

async function filterTreeByAsyncPathPolicy(tree, canReadPath) {
  async function filterNode(node) {
    if (node.type === "file") {
      return (await canReadPath(node.path)) ? node : null;
    }

    const children = [];
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const filteredChild = await filterNode(child);
      if (filteredChild) children.push(filteredChild);
    }

    if ((await canReadPath(node.path)) || children.length > 0) {
      return { ...node, children };
    }

    return null;
  }

  const result = [];
  for (const node of tree || []) {
    const filteredNode = await filterNode(node);
    if (filteredNode) result.push(filteredNode);
  }
  return result;
}

async function getVaultToolPathPolicy(context) {
  if (context.isAdmin) {
    return {
      canReadPath: async () => true,
      canWritePath: () => true,
    };
  }

  if (!context?.tenantId) {
    throw Object.assign(new Error("Workspace non défini"), { statusCode: 400 });
  }

  const { ensureWorkspaceBaseStructure, createWorkspacePathPolicy } = await import("../../services/vault/vault-service.js");
  await ensureWorkspaceBaseStructure(context.tenantId, context.userId);
  const workspacePolicy = await createWorkspacePathPolicy(context.tenantId, context.userId, context.userRole, {
    isAgentContext: Boolean(context.agentId),
  });

  if (!context.agentId) {
    return {
      canReadPath: async (inputPath) => workspacePolicy.canReadPath(inputPath),
      canWritePath: workspacePolicy.canWritePath,
    };
  }

  const { prisma } = await import("../../prisma.js");

  const requesterWorkspaceId = String(context.tenantId || "").trim();
  const requesterUserId = normalizeOwnerId(context.userId);

  const workspaceMapsCache = new Map();
  const parentWorkspaceCache = new Map();
  const ownerUserInfoCache = new Map();
  const requesterVsOwnerWorkspaceCache = new Map();

  async function getWorkspaceMaps(workspaceId) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (workspaceMapsCache.has(normalizedWorkspaceId)) {
      return workspaceMapsCache.get(normalizedWorkspaceId);
    }

    const [rawOwnersMap, rawVisibilityMap, rawAiShareMap] = await Promise.all([
      readWorkspaceVaultMap(normalizedWorkspaceId, VAULT_FOLDER_OWNERS_FILE),
      readWorkspaceVaultMap(normalizedWorkspaceId, VAULT_USER_VISIBILITY_FILE),
      readWorkspaceVaultMap(normalizedWorkspaceId, VAULT_AI_SHARING_FILE),
    ]);

    const folderOwnersMap = {};
    for (const [key, value] of Object.entries(rawOwnersMap || {})) {
      const normalizedKey = normalizeVaultToolPath(key);
      const normalizedValue = normalizeOwnerId(value);
      if (!normalizedKey || !normalizedValue) continue;
      folderOwnersMap[normalizedKey] = normalizedValue;
    }

    const visibilityMap = {};
    for (const [key, value] of Object.entries(rawVisibilityMap || {})) {
      const normalizedKey = normalizeVaultToolPath(key);
      if (!normalizedKey) continue;
      visibilityMap[normalizedKey] = String(value || "").trim().toLowerCase();
    }

    const aiShareMap = {};
    for (const [key, value] of Object.entries(rawAiShareMap || {})) {
      const normalizedKey = normalizeVaultToolPath(key);
      if (!normalizedKey) continue;
      aiShareMap[normalizedKey] = normalizeAiShareMode(value);
    }

    const entry = { folderOwnersMap, visibilityMap, aiShareMap };
    workspaceMapsCache.set(normalizedWorkspaceId, entry);
    return entry;
  }

  async function getOwnerUserInfo(ownerId, fallbackWorkspaceId) {
    if (!ownerId) return { workspaceId: fallbackWorkspaceId, role: null };
    if (ownerUserInfoCache.has(ownerId)) {
      return ownerUserInfoCache.get(ownerId) || { workspaceId: fallbackWorkspaceId, role: null };
    }

    const numericOwnerId = Number(ownerId);
    if (!Number.isInteger(numericOwnerId)) {
      const fallback = { workspaceId: fallbackWorkspaceId, role: null };
      ownerUserInfoCache.set(ownerId, fallback);
      return fallback;
    }

    const owner = await prisma.user.findUnique({
      where: { id: numericOwnerId },
      select: { workspaceId: true, role: true },
    });

    const ownerUserInfo = {
      workspaceId: owner?.workspaceId || fallbackWorkspaceId,
      role: owner?.role || null,
    };
    ownerUserInfoCache.set(ownerId, ownerUserInfo);
    return ownerUserInfo;
  }

  async function getRequesterVsOwnerWorkspaceRelation(ownerWorkspaceId) {
    const normalizedOwnerWorkspaceId = String(ownerWorkspaceId || "").trim();
    if (!normalizedOwnerWorkspaceId || !requesterWorkspaceId) {
      return { above: false, below: false };
    }

    if (requesterVsOwnerWorkspaceCache.has(normalizedOwnerWorkspaceId)) {
      return requesterVsOwnerWorkspaceCache.get(normalizedOwnerWorkspaceId);
    }

    const [above, below] = await Promise.all([
      isWorkspaceAncestor(prisma, requesterWorkspaceId, normalizedOwnerWorkspaceId, parentWorkspaceCache),
      isWorkspaceAncestor(prisma, normalizedOwnerWorkspaceId, requesterWorkspaceId, parentWorkspaceCache),
    ]);

    const relation = { above, below };
    requesterVsOwnerWorkspaceCache.set(normalizedOwnerWorkspaceId, relation);
    return relation;
  }

  async function canAgentReadWorkspacePath(targetWorkspaceId, notePath) {
    const normalizedWorkspaceId = String(targetWorkspaceId || "").trim();
    const normalizedNotePath = normalizeVaultToolPath(notePath);
    if (!normalizedWorkspaceId || !normalizedNotePath) return false;

    const topLevel = topLevelFolder(normalizedNotePath);
    if (topLevel === VAULT_SYSTEM_DIR || topLevel === VAULT_GLOBAL_DIR) {
      return true;
    }

    const { folderOwnersMap, visibilityMap, aiShareMap } = await getWorkspaceMaps(normalizedWorkspaceId);

    const ownerFromMap = normalizeOwnerId(getNearestPathMapValue(folderOwnersMap, normalizedNotePath));
    const ownerId = ownerFromMap || extractTopLevelOwnerId(normalizedNotePath);
    if (!ownerId) return false;

    if (ownerId === requesterUserId) return true;

    const shareModeFromMap = getNearestPathMapValue(aiShareMap, normalizedNotePath);
    const visibilityMode = visibilityMap[topLevelFolder(normalizedNotePath)] === "public" ? "shared" : null;
    const shareMode = normalizeAiShareMode(shareModeFromMap || visibilityMode || "owner_only");
    if (shareMode === "owner_only") return false;

    const ownerUserInfo = await getOwnerUserInfo(ownerId, normalizedWorkspaceId);
    const ownerWorkspaceId = ownerUserInfo.workspaceId;

    if (ownerWorkspaceId && requesterWorkspaceId && ownerWorkspaceId === requesterWorkspaceId) {
      const roleRank = {
        sub_client: 1,
        client: 2,
        admin: 3,
      };

      const requesterRank = roleRank[String(context.userRole || "").trim().toLowerCase()] || 0;
      const ownerRank = roleRank[String(ownerUserInfo.role || "").trim().toLowerCase()] || 0;

      if (shareMode === "shared") {
        return requesterRank > ownerRank;
      }

      if (shareMode === "shared_full") {
        return requesterRank !== ownerRank;
      }
    }

    const relation = await getRequesterVsOwnerWorkspaceRelation(ownerWorkspaceId);

    if (shareMode === "shared") {
      return relation.above;
    }

    if (shareMode === "shared_full") {
      return relation.above || relation.below;
    }

    return false;
  }

  return {
    canReadPath: async (inputPath) => {
      const parsedPath = parseVaultScopedPath(inputPath, requesterWorkspaceId);

      if (parsedPath.scope === "global") {
        return true;
      }

      if (parsedPath.scope !== "workspace") {
        return false;
      }

      if (!parsedPath.workspaceId || !parsedPath.notePath) {
        return false;
      }

      return canAgentReadWorkspacePath(parsedPath.workspaceId, parsedPath.notePath);
    },
    canWritePath: workspacePolicy.canWritePath,
  };
}

const vault_read = {
  name: "vault_read",
  description:
    "Lit le contenu d'une note markdown dans le vault Obsidian-style du workspace. Retourne le contenu brut, le frontmatter YAML et le titre.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Chemin de la note relative à la racine du vault (ex: 'Clients/SELI/00-Overview.md')"
      }
    },
    required: ["path"]
  },
  async execute(params, context) {
    if (!context.tenantId && !context.isAdmin) return { error: "Workspace non défini" };
    if (!canReadVaultToolContext(context)) {
      return { error: "Accès vault non autorisé pour cet utilisateur" };
    }

    const requestedPath = normalizeVaultToolPath(params.path || "");
    if (!requestedPath) return { error: "Chemin de note requis" };

    const policy = await getVaultToolPathPolicy(context);
    if (!(await policy.canReadPath(requestedPath))) {
      return { error: "Accès interdit à cette note du vault" };
    }

    const parsedPath = parseVaultScopedPath(requestedPath, context.tenantId || null);
    if (parsedPath.isRootScoped) {
      if (parsedPath.scope === "workspace" && (!parsedPath.workspaceId || !parsedPath.notePath)) {
        return { error: "Chemin de note invalide. Utilisez Workspaces/:id/<note>.md" };
      }
      if (parsedPath.scope === "global" && !parsedPath.notePath) {
        return { error: "Chemin de note invalide. Utilisez Global/<note>.md" };
      }

      const { readRootNote } = await import("../../services/vault/vault-service.js");
      return readRootNote(parsedPath.rootPath);
    }

    if (!context.tenantId) {
      return { error: "Chemin workspace relatif invalide sans workspace courant" };
    }

    const { readNote } = await import("../../services/vault/vault-service.js");
    return readNote(context.tenantId, parsedPath.notePath);
  }
};

const vault_write = {
  name: "vault_write",
  description:
    "Crée ou met à jour une note markdown dans le vault du workspace. Le contenu remplace entièrement la note si elle existe déjà.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Chemin de la note (ex: 'Meetings/2026-04-14.md')"
      },
      content: {
        type: "string",
        description: "Contenu markdown de la note (peut inclure un frontmatter YAML)"
      }
    },
    required: ["path", "content"]
  },
  async execute(params, context) {
    if (!context.tenantId && !context.isAdmin) return { error: "Workspace non défini" };
    if (!canWriteVaultToolContext(context)) {
      return { error: "Écriture vault non autorisée pour cet utilisateur" };
    }

    const requestedPath = normalizeVaultToolPath(params.path || "");
    if (!requestedPath) return { error: "Chemin de note requis" };

    const policy = await getVaultToolPathPolicy(context);
    if (!policy.canWritePath(requestedPath)) {
      return { error: "Écriture interdite dans ce dossier du vault" };
    }

    const parsedPath = parseVaultScopedPath(requestedPath, context.tenantId || null);
    if (parsedPath.isRootScoped) {
      if (!context.isAdmin) {
        return { error: "Écriture root scope réservée aux admins" };
      }
      if (parsedPath.scope === "workspace" && (!parsedPath.workspaceId || !parsedPath.notePath)) {
        return { error: "Chemin de note invalide. Utilisez Workspaces/:id/<note>.md" };
      }
      if (parsedPath.scope === "global" && !parsedPath.notePath) {
        return { error: "Chemin de note invalide. Utilisez Global/<note>.md" };
      }

      const { writeRootNote } = await import("../../services/vault/vault-service.js");
      return writeRootNote(parsedPath.rootPath, params.content);
    }

    if (!context.tenantId) {
      return { error: "Chemin workspace relatif invalide sans workspace courant" };
    }

    const { writeNote } = await import("../../services/vault/vault-service.js");
    return writeNote(context.tenantId, parsedPath.notePath, params.content);
  }
};

const vault_append = {
  name: "vault_append",
  description:
    "Ajoute du contenu à la fin d'une note existante dans le vault. Crée la note si elle n'existe pas encore.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Chemin de la note cible"
      },
      content: {
        type: "string",
        description: "Contenu à ajouter à la fin de la note"
      }
    },
    required: ["path", "content"]
  },
  async execute(params, context) {
    if (!context.tenantId && !context.isAdmin) return { error: "Workspace non défini" };
    if (!canWriteVaultToolContext(context)) {
      return { error: "Écriture vault non autorisée pour cet utilisateur" };
    }

    const requestedPath = normalizeVaultToolPath(params.path || "");
    if (!requestedPath) return { error: "Chemin de note requis" };

    const policy = await getVaultToolPathPolicy(context);
    if (!policy.canWritePath(requestedPath)) {
      return { error: "Écriture interdite dans ce dossier du vault" };
    }

    const parsedPath = parseVaultScopedPath(requestedPath, context.tenantId || null);
    if (parsedPath.isRootScoped) {
      if (!context.isAdmin) {
        return { error: "Écriture root scope réservée aux admins" };
      }
      if (parsedPath.scope === "workspace" && (!parsedPath.workspaceId || !parsedPath.notePath)) {
        return { error: "Chemin de note invalide. Utilisez Workspaces/:id/<note>.md" };
      }
      if (parsedPath.scope === "global" && !parsedPath.notePath) {
        return { error: "Chemin de note invalide. Utilisez Global/<note>.md" };
      }

      const { appendRootNote } = await import("../../services/vault/vault-service.js");
      return appendRootNote(parsedPath.rootPath, params.content);
    }

    if (!context.tenantId) {
      return { error: "Chemin workspace relatif invalide sans workspace courant" };
    }

    const { appendNote } = await import("../../services/vault/vault-service.js");
    return appendNote(context.tenantId, parsedPath.notePath, params.content);
  }
};

const vault_delete = {
  name: "vault_delete",
  description:
    "Supprime une note markdown du vault du workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Chemin de la note cible"
      }
    },
    required: ["path"]
  },
  async execute(params, context) {
    if (!context.tenantId && !context.isAdmin) return { error: "Workspace non défini" };
    if (!canWriteVaultToolContext(context)) {
      return { error: "Écriture vault non autorisée pour cet utilisateur" };
    }

    const requestedPath = normalizeVaultToolPath(params.path || "");
    if (!requestedPath) return { error: "Chemin de note requis" };

    const policy = await getVaultToolPathPolicy(context);
    if (!policy.canWritePath(requestedPath)) {
      return { error: "Écriture interdite dans ce dossier du vault" };
    }

    const parsedPath = parseVaultScopedPath(requestedPath, context.tenantId || null);
    if (parsedPath.isRootScoped) {
      if (!context.isAdmin) {
        return { error: "Écriture root scope réservée aux admins" };
      }
      if (parsedPath.scope === "workspace" && (!parsedPath.workspaceId || !parsedPath.notePath)) {
        return { error: "Chemin de note invalide. Utilisez Workspaces/:id/<note>.md" };
      }
      if (parsedPath.scope === "global" && !parsedPath.notePath) {
        return { error: "Chemin de note invalide. Utilisez Global/<note>.md" };
      }

      const { deleteRootNote } = await import("../../services/vault/vault-service.js");
      return deleteRootNote(parsedPath.rootPath);
    }

    if (!context.tenantId) {
      return { error: "Chemin workspace relatif invalide sans workspace courant" };
    }

    const { deleteNote } = await import("../../services/vault/vault-service.js");
    return deleteNote(context.tenantId, parsedPath.notePath);
  }
};

const vault_search = {
  name: "vault_search",
  description:
    "Recherche des notes dans le vault par mots-clés. Cherche dans les titres, tags et le contenu des fichiers.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Termes de recherche"
      },
      limit: {
        type: "number",
        description: "Nombre maximum de résultats (défaut: 10)"
      }
    },
    required: ["query"]
  },
  async execute(params, context) {
    if (!context.tenantId && !context.isAdmin) return { error: "Workspace non défini" };
    if (!canReadVaultToolContext(context)) {
      return { error: "Accès vault non autorisé pour cet utilisateur" };
    }

    const policy = await getVaultToolPathPolicy(context);

    const max = Math.max(1, Number(params.limit) || 10);
    const searchLimit = Math.min(200, max * 20);
    const isAgentContext = Boolean(context.agentId);

    const { searchNotes, searchRootNotes } = await import("../../services/vault/vault-service.js");
    const rawResults = isAgentContext
      ? await searchRootNotes(params.query, searchLimit)
      : await searchNotes(context.tenantId, params.query, searchLimit);

    const results = [];
    for (const item of rawResults) {
      if (await policy.canReadPath(item.path)) {
        results.push(item);
      }
      if (results.length >= max) break;
    }

    return { results };
  }
};

const vault_list = {
  name: "vault_list",
  description:
    "Liste les notes et dossiers dans le vault (ou un sous-dossier). Retourne l'arborescence des fichiers markdown.",
  parameters: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        description: "Sous-dossier à explorer (ex: 'Clients/SELI'). Laisser vide pour la racine."
      }
    },
    required: []
  },
  async execute(params, context) {
    if (!context.tenantId && !context.isAdmin) return { error: "Workspace non défini" };
    if (!canReadVaultToolContext(context)) {
      return { error: "Accès vault non autorisé pour cet utilisateur" };
    }

    const policy = await getVaultToolPathPolicy(context);
    const folder = normalizeVaultToolPath(params.folder || "");
    const parsedFolder = parseVaultScopedPath(folder, context.tenantId || null);
    const isAgentContext = Boolean(context.agentId);

    const { listTree, listRootTree } = await import("../../services/vault/vault-service.js");

    let rawTree = [];
    if (isAgentContext || parsedFolder.isRootScoped) {
      if (!parsedFolder.isRootScoped && !context.tenantId && folder) {
        return { error: "Chemin workspace relatif invalide sans workspace courant" };
      }

      const rootFolder = folder
        ? (parsedFolder.isRootScoped
          ? parsedFolder.rootPath
          : toWorkspaceRootPath(context.tenantId, parsedFolder.notePath))
        : "";

      rawTree = await listRootTree(rootFolder);
    } else {
      rawTree = await listTree(context.tenantId, parsedFolder.notePath || "");
    }

    const tree = await filterTreeByAsyncPathPolicy(rawTree, policy.canReadPath);
    return { tree };
  }
};

// ── Generaliste Utility Tools ─────────────────────────

const get_user_gps = {
  name: "get_user_gps",
  description:
    "Obtient la localisation de l'utilisateur (ville, pays, coordonnées GPS) pour les demandes météo ou géographiques. " +
    "Si la localisation n'est pas stockée, demande à l'utilisateur.",
  parameters: {
    type: "object",
    properties: {
      hint: {
        type: "string",
        description: "Contexte optionnel expliquant pourquoi la localisation est demandée"
      }
    },
    required: []
  },
  async execute(params, _context) {
    return {
      type: "ask_user_pending",
      question: "Quelle est votre ville ou localisation actuelle ?",
      suggestions: ["Paris, France", "Lyon, France", "Marseille, France", "Bordeaux, France", "Autre"],
      context: params.hint || "Localisation nécessaire pour répondre à votre demande.",
      message: "Localisation requise — question transmise à l'utilisateur. Attendez la réponse avant d'appeler get_meteo."
    };
  }
};

const get_meteo = {
  name: "get_meteo",
  description:
    "Récupère les prévisions météo sur 7 jours pour une ville ou des coordonnées GPS via Open-Meteo (API gratuite, sans clé). " +
    "Si seul le nom de la ville est fourni, utilise Nominatim (OpenStreetMap) pour le géocodage.",
  parameters: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "Nom de la ville avec pays optionnel (ex: 'Paris', 'Bordeaux, France', 'New York, USA')"
      },
      latitude: {
        type: "number",
        description: "Latitude GPS (optionnel si city est fourni)"
      },
      longitude: {
        type: "number",
        description: "Longitude GPS (optionnel si city est fourni)"
      }
    },
    required: []
  },
  async execute(params, _context) {
    let lat = params.latitude;
    let lon = params.longitude;
    let cityName = params.city;

    // Step 1: Géocodage par ville (Nominatim OSM) si lat/lon pas fournis
    if ((!lat || !lon) && cityName) {
      try {
        const encoded = encodeURIComponent(cityName);
        const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`;
        const geoResp = await fetch(geoUrl, {
          headers: { "User-Agent": "Boatswain-Dashboard/1.0" }
        });

        if (!geoResp.ok) {
          return { error: `Géocodage échoué pour "${cityName}" (code ${geoResp.status})` };
        }

        const geoData = await geoResp.json();
        if (!geoData || geoData.length === 0) {
          return { error: `Ville introuvable: "${cityName}". Essayez avec un format comme "Paris, France".` };
        }

        lat = parseFloat(geoData[0].lat);
        lon = parseFloat(geoData[0].lon);
        cityName = geoData[0].display_name?.split(",")[0] || cityName;
      } catch (err) {
        return { error: `Erreur géocodage Nominatim: ${err.message}` };
      }
    }

    if (!lat || !lon) {
      return { error: "Coordonnées GPS manquantes. Fournissez city ou latitude + longitude." };
    }

    // Step 2: Récupérer prévisions météo Open-Meteo
    try {
      const weatherUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=7`;

      const weatherResp = await fetch(weatherUrl);
      if (!weatherResp.ok) {
        return { error: `Erreur API Open-Meteo (code ${weatherResp.status})` };
      }

      const wd = await weatherResp.json();

      if (!wd.daily || !wd.daily.time) {
        return { error: "Réponse météo invalide de Open-Meteo" };
      }

      const forecast = (wd.daily.time || []).map((date, i) => ({
        date,
        temp_max: wd.daily.temperature_2m_max[i],
        temp_min: wd.daily.temperature_2m_min[i],
        weathercode: wd.daily.weathercode[i]
      }));

      return {
        city: cityName,
        latitude: lat,
        longitude: lon,
        timezone: wd.timezone || "UTC",
        forecast,
        source: "open-meteo.com"
      };
    } catch (err) {
      return { error: `Erreur fetch météo: ${err.message}` };
    }
  }
};

// ── Tool Registry ─────────────────────────────────────

/**
 * All available tools. Each tool has:
 *   name, description, parameters (JSON Schema), execute(params, context)
 */
export const ALL_TOOLS = [
  // Sellsy CRM — read
  sellsy_get_company, sellsy_get_contact, sellsy_get_opportunity,
  sellsy_search_companies, sellsy_search_contacts, sellsy_get_pipeline,
  sellsy_get_activities, sellsy_get_invoices, sellsy_get_quote,
  sellsy_get_opportunities, sellsy_get_products, sellsy_get_tasks,
  sellsy_get_crm_stats, sellsy_global_search,
  // Sellsy CRM — write
  sellsy_update_opportunity, sellsy_update_company, sellsy_update_contact,
  sellsy_update_quote, sellsy_create_note,
  sellsy_create_contact, sellsy_create_company, sellsy_create_opportunity,
  sellsy_create_quote, sellsy_send_quote,
  sellsy_create_invoice, sellsy_send_invoice,
  sellsy_create_task,
  // Interaction
  ask_user,
  navigate_to,
  // Web search & scrape
  web_search,
  web_scrape,
  // File processing
  parse_pdf,
  parse_csv,
  parse_excel,
  parse_word,
  parse_powerpoint,
  parse_opendocument,
  parse_json,
  parse_image,
  parse_audio,
  // Report generation
  generate_report,
  // Reminders
  schedule_reminder,
  // Email
  send_email,
  // Calendar
  create_calendar_event,
  // Phase 3 — CRM operations
  enrich_company_data,
  create_task,
  // Admin platform stats
  get_platform_stats,
  // Vault
  vault_read,
  vault_write,
  vault_append,
  vault_delete,
  vault_search,
  vault_list,
  // Generaliste utility tools
  get_user_gps,
  get_meteo,
];

/**
 * Returns the subset of tools available given a context.
 * Only includes tools that can actually work (e.g., no Sellsy tools if no client).
 */
export function getAvailableTools(context = {}, options = {}) {
  const tools = [];
  const {
    includeFileTools = true,
    thinkingMode = "low"
  } = options;

  // Admin platform stats — always first for admins
  if (context.isAdmin) {
    tools.push(get_platform_stats);
  }

  // Interaction tools — always available
  tools.push(ask_user, navigate_to);

  // Sellsy tools only if client is connected
  if (context.sellsyClient) {
    tools.push(
      // Read
      sellsy_get_company, sellsy_get_contact, sellsy_get_opportunity,
      sellsy_search_companies, sellsy_search_contacts, sellsy_get_pipeline,
      sellsy_get_activities, sellsy_get_invoices, sellsy_get_quote,
      sellsy_get_opportunities, sellsy_get_products, sellsy_get_tasks,
      sellsy_get_crm_stats, sellsy_global_search,
      // Write
      sellsy_update_opportunity, sellsy_update_company, sellsy_update_contact,
      sellsy_update_quote, sellsy_create_note,
      sellsy_create_contact, sellsy_create_company, sellsy_create_opportunity,
      sellsy_create_quote, sellsy_send_quote,
      sellsy_create_invoice, sellsy_send_invoice,
      sellsy_create_task
    );
  }

  // Web search + scrape always available when Tavily API key is configured.
  if (context.tavilyApiKey) {
    tools.push(web_search, web_scrape);
  }

  // File tools only if there are uploaded files
  if (includeFileTools && context.uploadedFiles?.length > 0) {
    tools.push(parse_pdf, parse_csv, parse_excel, parse_word, parse_powerpoint, parse_opendocument, parse_json, parse_text, parse_image, parse_audio);
  }

  // Report generation — always available
  tools.push(generate_report);

  // Generaliste utility tools — always available (free APIs, no key required)
  tools.push(get_user_gps, get_meteo);

  // Reminder tool — disponible si un userId est dans le contexte
  if (context.userId) {
    const isAdmin = context.isAdmin === true;
    const hasWorkspace = Boolean(context.tenantId);

    tools.push(schedule_reminder);

    // Admin can use personal email/calendar tools without a workspace.
    if (isAdmin || context.features?.email_service) {
      tools.push(send_email);
    }

    if (isAdmin || context.features?.calendar) {
      tools.push(create_calendar_event);
    }

    // Workspace-scoped non-chat actions remain guarded by workspace presence.
    if (hasWorkspace && (isAdmin || context.features?.data_enrichment)) {
      tools.push(enrich_company_data);
    }
    if (hasWorkspace && (isAdmin || context.features?.mass_import)) {
      tools.push(create_task);
    }

    // Vault tools — strict read/write gating
    if (canReadVaultToolContext(context)) {
      tools.push(vault_read, vault_search, vault_list);
      if (canWriteVaultToolContext(context)) {
        tools.push(vault_write, vault_append, vault_delete);
      }
    }
  }

  // Low thinking mode: keep constrained tool surface (but always include all sellsy + admin tools)
  if (thinkingMode === "low") {
    return tools.filter((tool) => {
      if (tool.name === "get_platform_stats") return true;
      if (tool.name === "ask_user") return true;
      if (tool.name === "navigate_to") return true;
      if (tool.name === "web_search") return true;
      if (tool.name === "web_scrape") return true;
      if (tool.name.startsWith("sellsy_")) return true;
      if (tool.name.startsWith("parse_")) return true;
      if (tool.name === "schedule_reminder") return true;
      if (tool.name === "send_email") return true;
      if (tool.name === "create_calendar_event") return true;
      if (tool.name === "enrich_company_data") return true;
      if (tool.name === "create_task") return true;
      if (tool.name.startsWith("vault_")) return true;
      if (tool.name === "get_user_gps") return true;
      if (tool.name === "get_meteo") return true;
      return false;
    });
  }

  return tools;
}

/**
 * Execute a tool by name with given params and context.
 * @param {string} toolName
 * @param {Object} params
 * @param {Object} context - { sellsyClient, tavilyApiKey, uploadedFiles }
 * @returns {Promise<Object>}
 */
export async function executeTool(toolName, params, context) {
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    return { error: `Outil inconnu: ${toolName}` };
  }

  try {
    const result = await tool.execute(params, context);
    return result;
  } catch (error) {
    return { error: `Erreur lors de l'exécution de ${toolName}: ${error.message}` };
  }
}

/**
 * Sanitize a JSON schema to be strictly Mistral-compliant.
 * Removes unsupported fields and ensures required structure.
 */
function sanitizeSchemaForMistral(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, required: [] };
  }

  const sanitized = {
    type: schema.type || "object",
    properties: schema.properties || {},
    required: Array.isArray(schema.required) ? schema.required : []
  };

  // Recursively sanitize nested properties
  if (sanitized.properties && typeof sanitized.properties === "object") {
    for (const [key, prop] of Object.entries(sanitized.properties)) {
      if (prop && typeof prop === "object") {
        // Keep only Mistral-supported fields at property level
        const sanitizedProp = {};
        if (prop.type) sanitizedProp.type = prop.type;
        if (prop.description) sanitizedProp.description = prop.description;
        if (prop.enum) sanitizedProp.enum = prop.enum;
        if (prop.items) sanitizedProp.items = sanitizeSchemaForMistral(prop.items);
        if (prop.properties) {
          sanitizedProp.properties = {};
          for (const [subKey, subProp] of Object.entries(prop.properties)) {
            sanitizedProp.properties[subKey] = sanitizeSchemaForMistral(subProp);
          }
        }
        if (Array.isArray(prop.required)) sanitizedProp.required = prop.required;
        sanitized.properties[key] = sanitizedProp;
      }
    }
  }

  return sanitized;
}

/**
 * Convert tools array to OpenAI function-calling format.
 */
export function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

/**
 * Convert tools array to Mistral-compliant function-calling format.
 * Includes strict schema validation and sanitization for Mistral API compatibility.
 */
export function toMistralTools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: sanitizeSchemaForMistral(t.parameters)
    }
  }));
}

/**
 * Convert tools array to Anthropic tool format.
 */
export function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}
