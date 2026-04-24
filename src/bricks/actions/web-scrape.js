import { z } from "../types.js";
import { resolveTavilyApiKeyForAutomation } from "../../services/automations/integration-resolvers.js";

function normalizeUrls(value) {
  if (Array.isArray(value)) {
    return value
      .map((url) => String(url || "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[\n,;]/g)
      .map((url) => url.trim())
      .filter(Boolean);
  }

  return [];
}

export const webScrapeAction = {
  id: "action:web_scrape",
  category: "action",
  name: "Extraction web (Tavily)",
  description: "Extrait le contenu texte brut de pages web via Tavily Extract.",
  icon: "Search",
  color: "#2c7be5",

  inputSchema: z.object({
    urls: z.any().describe("Liste d'URLs (array ou string separee par lignes)") ,
    maxChars: z.string().optional().describe("Longueur max par resultat (defaut: 6000, max: 20000)"),
    tavilySource: z.string().optional().describe("Source Tavily: auto | env | workspace:<id> | user:<id>"),
  }),

  outputSchema: z.object({
    urls: z.any(),
    results: z.any(),
    failedUrls: z.any(),
    source: z.string().optional(),
  }),

  async execute(inputs, context) {
    const urls = normalizeUrls(inputs.urls).slice(0, 5);
    if (urls.length === 0) {
      throw new Error("Au moins une URL est requise");
    }

    const source = await resolveTavilyApiKeyForAutomation({
      workspaceId: context.workspaceId,
      userId: context.userId,
      userRole: context.userRole,
      sourceRef: inputs.tavilySource,
    });

    const parsedMaxChars = Number(inputs.maxChars);
    const maxChars = Number.isFinite(parsedMaxChars)
      ? Math.min(Math.max(Math.floor(parsedMaxChars), 500), 20_000)
      : 6000;

    const { tavily } = await import("@tavily/core");
    const client = tavily({ apiKey: source.apiKey });

    const response = await client.extract(urls);
    const results = Array.isArray(response.results) ? response.results : [];
    const failedResults = Array.isArray(response.failedResults) ? response.failedResults : [];

    return {
      urls,
      source: source.label,
      results: results.map((item) => ({
        url: item.url,
        rawContent: String(item.rawContent || "").slice(0, maxChars),
        truncated: String(item.rawContent || "").length > maxChars,
      })),
      failedUrls: failedResults.map((item) => item.url).filter(Boolean),
    };
  },
};
