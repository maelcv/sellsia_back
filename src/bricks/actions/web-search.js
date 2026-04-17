import { z } from "../types.js";

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
  }),

  outputSchema: z.object({
    results: z.any().describe("Tableau de résultats [{title, url, content, score}]"),
    query:   z.string(),
  }),

  async execute(inputs, context) {
    const { query, maxResults, searchDepth, includeDomains, excludeDomains } = inputs;
    if (!query) throw new Error("query est requis");

    const { config } = await import("../../config.js");
    if (!config.tavilyApiKey) throw new Error("TAVILY_API_KEY non configurée");

    const { tavily } = await import("@tavily/core");
    const client = tavily({ apiKey: config.tavilyApiKey });

    const n = Math.min(parseInt(maxResults || "5", 10), 10);

    const opts = {
      maxResults: n,
      searchDepth: searchDepth || "basic",
    };

    if (includeDomains) {
      opts.includeDomains = includeDomains.split(",").map((d) => d.trim()).filter(Boolean);
    }
    if (excludeDomains) {
      opts.excludeDomains = excludeDomains.split(",").map((d) => d.trim()).filter(Boolean);
    }

    const response = await client.search(query, opts);

    const results = (response.results || []).map((r) => ({
      title:   r.title,
      url:     r.url,
      content: r.content,
      score:   r.score,
    }));

    return { results, query };
  },
};
