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
import { dirname, resolve } from "node:path";

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

// ── File Processing Tools ─────────────────────────────

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

    try {
      const pdfParse = require("pdf-parse");
      const result = await pdfParse(file.buffer);
      return {
        filename: file.originalname,
        pages: result.numpages,
        text: result.text?.slice(0, 8000),
        truncated: (result.text?.length || 0) > 8000
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

      return {
        filename: file.originalname,
        text: result.value?.slice(0, 8000),
        truncated: (result.value?.length || 0) > 8000,
        warnings: result.messages?.filter((m) => m.type === "warning").map((m) => m.message).slice(0, 5)
      };
    } catch (error) {
      return { error: `Erreur parsing Word: ${error.message}` };
    }
  }
};

// ── Reminder Tool ────────────────────────────────────

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
        description: "Date et heure en UTC, format ISO 8601 (ex: '2025-03-25T09:00:00Z')"
      },
      channel: {
        type: "string",
        enum: ["chat", "whatsapp", "email"],
        description: "Canal de livraison : 'chat' (notification dans la plateforme), 'whatsapp' (message WhatsApp) ou 'email' (envoi par email)"
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

    const channel = params.channel || "chat";
    if (channel === "whatsapp" && !params.target_phone) {
      return { error: "target_phone est requis pour le canal whatsapp" };
    }
    if (channel === "email" && !params.target_email) {
      return { error: "target_email est requis pour le canal email" };
    }

    const timezone = params.timezone || "Europe/Paris";

    // Formate la date dans le fuseau horaire de l'utilisateur pour l'affichage
    const formattedDate = scheduledDate.toLocaleString("fr-FR", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "short",
    });

    const channelLabel = channel === "whatsapp"
      ? `WhatsApp (${params.target_phone})`
      : channel === "email"
      ? `Email (${params.target_email})`
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
      const { prisma } = await import("../../src/prisma.js");

      const reminder = await prisma.reminder.create({
        data: {
          userId,
          agentId: context.agentId || null,
          taskDescription: params.task_description,
          scheduledAt: scheduledDate,
          timezone,
          status: "PENDING",
          channel,
          targetPhone: params.target_phone || null,
          targetEmail: params.target_email || null,
        },
      });

      return {
        status: "scheduled",
        reminderId: reminder.id,
        scheduledAt: reminder.scheduledAt,
        channel: reminder.channel,
        message: `✅ Rappel confirmé et planifié ! Je vous rappellerai le ${formattedDate} : "${params.task_description}". (Réf. #${reminder.id})`
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
    if (!context.userId || !context.tenantId) {
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
      const { sendEmail } = await import("../email/email-service.js");
      await sendEmail({
        userId:   context.userId,
        tenantId: context.tenantId,
        to:       params.to,
        cc:       params.cc,
        subject:  params.subject,
        html:     params.body,
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
        description: "Date et heure de début en ISO 8601 UTC, ex: '2025-04-15T09:00:00Z'"
      },
      end_at: {
        type: "string",
        description: "Date et heure de fin en ISO 8601 UTC, ex: '2025-04-15T10:00:00Z'"
      },
      timezone: {
        type: "string",
        description: "Fuseau horaire de l'utilisateur, ex: 'Europe/Paris' (défaut)"
      },
      location: {
        type: "string",
        description: "Lieu de l'événement (optionnel)"
      }
    },
    required: ["title", "start_at", "end_at"]
  },
  async execute(params, context) {
    if (!context.userId || !context.tenantId) {
      return { error: "Contexte utilisateur manquant" };
    }

    try {
      const { prisma } = await import("../../src/prisma.js");
      const event = await prisma.calendarEvent.create({
        data: {
          userId:      context.userId,
          tenantId:    context.tenantId,
          title:       params.title,
          description: params.description ?? null,
          startAt:     new Date(params.start_at),
          endAt:       new Date(params.end_at),
          timezone:    params.timezone ?? "Europe/Paris",
          location:    params.location ?? null,
        },
      });
      return {
        status: "created",
        eventId: event.id,
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
      const { prisma } = await import("../../src/prisma.js");
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
      const { prisma } = await import("../../src/prisma.js");
      const task = await prisma.taskAssignment.create({
        data: {
          userId: context.userId,
          tenantId: context.tenantId,
          title: params.title,
          description: params.description || null,
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

export const FILE_TOOLS = [parse_pdf, parse_csv, parse_excel, parse_word];

export const SELLSY_TOOLS = [
  sellsy_get_company, sellsy_get_contact, sellsy_get_opportunity,
  sellsy_search_companies, sellsy_get_pipeline, sellsy_get_activities,
  sellsy_get_invoices, sellsy_get_quote, sellsy_get_opportunities,
  sellsy_update_opportunity, sellsy_update_company, sellsy_create_note
];

export const WEB_TOOLS = [web_search, web_scrape];

export const INTERACTION_TOOLS = [ask_user, navigate_to];

// ── Tool Registry ─────────────────────────────────────

/**
 * All available tools. Each tool has:
 *   name, description, parameters (JSON Schema), execute(params, context)
 */
export const ALL_TOOLS = [
  // Sellsy CRM — read
  sellsy_get_company,
  sellsy_get_contact,
  sellsy_get_opportunity,
  sellsy_search_companies,
  sellsy_get_pipeline,
  sellsy_get_activities,
  sellsy_get_invoices,
  sellsy_get_quote,
  sellsy_get_opportunities,
  // Sellsy CRM — write
  sellsy_update_opportunity,
  sellsy_update_company,
  sellsy_create_note,
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
  // Report generation
  generate_report,
  // Reminders — planification de rappels par les agents IA
  schedule_reminder,
  // Email — envoi d'emails par les agents IA
  send_email,
  // Calendar — création d'événements calendrier
  create_calendar_event,
  // Phase 3 — CRM operations
  enrich_company_data,
  create_task,
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

  // Interaction tools — always available
  tools.push(ask_user, navigate_to);

  // Sellsy tools only if client is connected
  if (context.sellsyClient) {
    tools.push(
      // Read
      sellsy_get_company,
      sellsy_get_contact,
      sellsy_get_opportunity,
      sellsy_search_companies,
      sellsy_get_pipeline,
      sellsy_get_activities,
      sellsy_get_invoices,
      sellsy_get_quote,
      sellsy_get_opportunities,
      // Write
      sellsy_update_opportunity,
      sellsy_update_company,
      sellsy_create_note
    );
  }

  // Web search + scrape always available when Tavily API key is configured.
  if (context.tavilyApiKey) {
    tools.push(web_search, web_scrape);
  }

  // File tools only if there are uploaded files
  if (includeFileTools && context.uploadedFiles?.length > 0) {
    tools.push(parse_pdf, parse_csv, parse_excel, parse_word);
  }

  // Report generation — always available
  tools.push(generate_report);

  // Reminder tool — disponible si un userId est dans le contexte
  if (context.userId) {
    tools.push(schedule_reminder);
    // Email tool — disponible si feature email_service activée
    if (context.features?.email_service) {
      tools.push(send_email);
    }
    // Calendar tool — disponible si feature calendar activée
    if (context.features?.calendar) {
      tools.push(create_calendar_event);
    }
    // Phase 3: CRM operations
    if (context.features?.data_enrichment) {
      tools.push(enrich_company_data);
    }
    if (context.features?.mass_import) {
      tools.push(create_task);
    }
  }

  // Low thinking mode keeps a constrained tool surface.
  if (thinkingMode === "low") {
    return tools.filter((tool) => {
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
