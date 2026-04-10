/**
 * Market report AI synthesis.
 * Uses dynamic provider from platform configuration instead of hardcoded Mistral.
 */
import { getProviderForTenant } from "../../providers/index.js";

const SYSTEM_PROMPT = `Tu es un analyste senior en matières premières agricoles, travaillant pour un courtier spécialisé en oléagineux et céréales.

Ton rôle : synthétiser l'actualité de marché en 3 points d'analyse concis, percutants et actionnables pour des professionnels du secteur (coopératives, huileries, négociants).

Format de réponse STRICTEMENT en JSON :
{
  "points": [
    "Point 1 : impact concis et actionnable (max 20 mots)",
    "Point 2 : facteur de marché clé (max 20 mots)",
    "Point 3 : perspective court terme (max 20 mots)"
  ],
  "tendance": "haussière" | "baissière" | "neutre",
  "niveau_risque": "faible" | "modéré" | "élevé"
}

Réponds UNIQUEMENT en JSON valide. Pas d'explication, pas de markdown. Toujours en français.`;

function fallbackSynthesis(articles, productName) {
  const points = articles.slice(0, 3).map((a) => {
    const short = a.title?.split(":").pop()?.trim() || a.title || "Information indisponible";
    return short.length > 100 ? short.substring(0, 97) + "..." : short;
  });
  while (points.length < 3) {
    points.push(`Marché ${productName} : surveillance conseillée`);
  }
  return { points, tendance: "neutre", niveau_risque: "modéré" };
}

export async function synthesizeProduct(productName, articles, provider, { demoMode = false } = {}) {
  if (demoMode || !provider) return fallbackSynthesis(articles, productName);

  const articlesText = articles
    .map((a, i) => `Article ${i + 1} — ${a.source} :\nTitre : ${a.title}\nRésumé : ${a.description}`)
    .join("\n\n");

  const userPrompt = `Produit analysé : ${productName}\n\n${articlesText}`;
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await provider.complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: userPrompt,
        temperature: 0.3,
        maxTokens: 400,
      });
      const content = response;
      if (!content) throw new Error("Réponse vide du provider IA");
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Format JSON invalide");
      const parsed = JSON.parse(match[0]);
      if (!parsed.points || !Array.isArray(parsed.points)) throw new Error("Structure invalide");
      return parsed;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) return fallbackSynthesis(articles, productName);
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

export async function synthesizeAll(newsData, productNames, workspaceId, opts = {}) {
  // Get dynamic provider for this workspace
  const provider = await getProviderForTenant(workspaceId);
  if (!provider && !opts.demoMode) {
    console.warn(`No AI provider configured for workspace ${workspaceId}, using fallback`);
  }

  const result = {};
  for (const [key, articles] of Object.entries(newsData)) {
    const name = productNames[key] || key;
    result[key] = await synthesizeProduct(name, articles, provider, opts);
    await new Promise((r) => setTimeout(r, 300));
  }
  return result;
}
