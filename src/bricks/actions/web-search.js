import { z } from "../types.js";
import {
  normalizeDomainListInput,
  resolveTavilyApiKeyForAutomation,
} from "../../services/automations/integration-resolvers.js";

export const webSearchAction = {
  id: "action:web_search",
  category: "action",
  name: "Recherche web (Tavily)",
  description: "Effectue une recherche internet via Tavily et retourne les résultats pertinents.",
  icon: "Search",
  color: "#2980b9",

  inputSchema: z.object({
    query:       z.string().describe("Requête de recherche (supporte {{variables}})"),
    maxResults:  z.string().optional().describe("Nombre max de résultats (défaut: 5, max: 10)"),
    searchDepth: z.enum(["basic", "advanced"]).optional().describe("Profondeur de recherche"),
    includeDomains: z.string().optional().describe("Domaines à inclure (séparés par des virgules)"),
    excludeDomains: z.string().optional().describe("Domaines à exclure (séparés par des virgules)"),
    tavilySource: z.string().optional().describe("Source Tavily: auto | env | workspace:<id> | user:<id>"),
  }),

  outputSchema: z.object({
    results: z.any().describe("Tableau de résultats [{title, url, content, score}]"),
    query:   z.string(),
    source:  z.string().optional(),
  }),

  async execute(inputs, context) {
    const {
      query,
      maxResults,
      searchDepth,
      includeDomains,
      excludeDomains,
      tavilySource,
    } = inputs;

    if (!query) throw new Error("query est requis");

    const source = await resolveTavilyApiKeyForAutomation({
      workspaceId: context.workspaceId,
      userId: context.userId,
      userRole: context.userRole,
      sourceRef: tavilySource,
    });

    const { tavily } = await import("@tavily/core");
    const client = tavily({ apiKey: source.apiKey });

    const parsedMax = Number(maxResults);
    const n = Math.min(Math.max(Number.isFinite(parsedMax) ? parsedMax : 5, 1), 10);

    const opts = {
      maxResults: n,
      searchDepth: searchDepth || "basic",
    };

    const normalizedIncludeDomains = normalizeDomainListInput(includeDomains);
    const normalizedExcludeDomains = normalizeDomainListInput(excludeDomains);

    if (normalizedIncludeDomains.length > 0) {
      opts.includeDomains = normalizedIncludeDomains;
    }

    if (normalizedExcludeDomains.length > 0) {
      opts.excludeDomains = normalizedExcludeDomains;
    }

    const response = await client.search(query, opts);

    const results = (response.results || []).map((r) => ({
      title:   r.title,
      url:     r.url,
      content: r.content,
      score:   r.score,
    }));

    return { results, query, source: source.label };
  },
};
