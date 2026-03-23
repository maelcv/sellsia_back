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
  generate_report
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

  // Low thinking mode keeps a constrained tool surface.
  if (thinkingMode === "low") {
    return tools.filter((tool) => {
      if (tool.name === "ask_user") return true;
      if (tool.name === "navigate_to") return true;
      if (tool.name === "web_search") return true;
      if (tool.name === "web_scrape") return true;
      if (tool.name.startsWith("sellsy_")) return true;
      if (tool.name.startsWith("parse_")) return true;
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
