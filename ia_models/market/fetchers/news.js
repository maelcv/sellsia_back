/**
 * News fetcher for market reports.
 * Ported from cgiraud/src/data/fetchers/news.js — DB-configured sources only,
 * no filesystem coupling. Returns per-product article arrays.
 */
import axios from "axios";
import {
  loadSourcesForWorkspace,
  executeApiSource,
  executeScrapingSource,
  mapApiResults,
} from "./source_engine.js";

const PRODUCT_KEYWORDS = {
  colza: ["colza", "rapeseed", "canola"],
  soja: ["soja", "soybean", "soy"],
  tournesol: ["tournesol", "sunflower"],
  palme: ["palme", "palm oil", "palm"],
  petrole: ["pétrole", "petrole", "oil", "brent", "crude"],
};

const DEMO_NEWS = {
  colza: [
    { title: "Marché du colza : stabilité attendue après les récoltes européennes", description: "Les cours du colza restent soutenus par une demande biodiesel solide.", source: "Agri Mutuel", publishedAt: new Date().toISOString(), url: "#", timeAgo: "2h" },
  ],
  soja: [
    { title: "Soja : tensions sud-américaines sur fond de climat", description: "Les exportateurs brésiliens révisent leurs prévisions.", source: "Reuters", publishedAt: new Date().toISOString(), url: "#", timeAgo: "3h" },
  ],
  tournesol: [
    { title: "Huile de tournesol : la mer Noire toujours sous surveillance", description: "Les flux ukrainiens reprennent partiellement.", source: "Terre-net", publishedAt: new Date().toISOString(), url: "#", timeAgo: "5h" },
  ],
  palme: [
    { title: "Huile de palme : la Malaisie revoit ses stocks", description: "Le MPOB publie des chiffres en baisse.", source: "Bloomberg", publishedAt: new Date().toISOString(), url: "#", timeAgo: "6h" },
  ],
  petrole: [
    { title: "Brent : l'OPEP+ maintient sa stratégie de production", description: "Les cours évoluent peu après la réunion.", source: "Les Échos", publishedAt: new Date().toISOString(), url: "#", timeAgo: "1h" },
  ],
};

function timeAgo(isoDate) {
  if (!isoDate) return "";
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (isNaN(diffMs) || diffMs < 0) return "";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}j`;
}

function matchProduct(text, keywords) {
  const lower = (text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function dedupe(articles) {
  const seen = new Set();
  return articles.filter((a) => {
    const key = (a.title || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const sourceItems = Array.isArray(items) ? items : [];
  let cursor = 0;

  async function runWorker() {
    while (cursor < sourceItems.length) {
      const index = cursor;
      cursor += 1;
      await worker(sourceItems[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(safeLimit, sourceItems.length) }, () => runWorker());
  await Promise.all(workers);
}

async function fetchFromNewsData(productKeywords) {
  const key = process.env.NEWSDATA_IO_API_KEY;
  if (!key || key.startsWith("your_")) return [];
  const query = productKeywords.join(" OR ");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get("https://newsdata.io/api/1/news", {
        params: {
          apikey: key,
          q: query,
          language: "fr,en",
          size: 10,
        },
        timeout: 12000,
      });
      return (res.data?.results || []).map((a) => ({
        title: a.title || "Sans titre",
        description: a.description || "",
        url: a.link || "#",
        source: a.source_id || "Newsdata.io",
        publishedAt: a.pubDate || new Date().toISOString(),
      }));
    } catch (err) {
      if (err.response?.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return [];
    }
  }
  return [];
}

/**
 * Fetch news for all configured products.
 * @param {{ workspaceId: string, products?: string[], demoMode?: boolean, sourceStatus?: Array }} opts
 * @returns {Promise<Record<string, Array>>}
 */
export async function fetchAllNews({
  workspaceId,
  products = Object.keys(PRODUCT_KEYWORDS),
  demoMode = false,
  sourceStatus = [],
} = {}) {
  if (demoMode) {
    const out = {};
    for (const key of products) out[key] = DEMO_NEWS[key] || [];
    return out;
  }

  const sources = await loadSourcesForWorkspace(workspaceId);
  const newsSources = sources.filter(
    (s) => !s.content_type || s.content_type === "news"
  );

  // Collect a global pool of articles from all news sources
  const pool = [];
  const productQuery = products.flatMap((k) => PRODUCT_KEYWORDS[k] || [k]).join(" OR ");
  await mapWithConcurrency(newsSources, 3, async (src) => {
    try {
      if (src.type === "api") {
        const raw = await executeApiSource(src, { query: productQuery || "matières premières agricoles" });
        const mapped = mapApiResults(raw, src.config.mappings || {});
        if (mapped.length > 0) pool.push(...mapped);
        sourceStatus.push({ source: src.id, status: "ok", count: mapped.length, kind: "news" });
        return;
      }

      if (src.type === "scrapping") {
        const urls = src.config?.urls_to_scrape || [];
        const scrapedItems = [];
        await mapWithConcurrency(urls, 2, async (u) => {
          const items = await executeScrapingSource(src, u.id);
          if (Array.isArray(items) && items.length > 0) {
            scrapedItems.push(...items);
          }
        });
        if (scrapedItems.length > 0) pool.push(...scrapedItems);
        sourceStatus.push({ source: src.id, status: "ok", count: scrapedItems.length, kind: "news" });
      }
    } catch (err) {
      sourceStatus.push({ source: src.id, status: "error", message: err.message, kind: "news" });
    }
  });

  // One-shot fallback: if pool from configured sources is empty, call newsdata.io once
  if (pool.length === 0) {
    const allKws = Object.values(PRODUCT_KEYWORDS).flat();
    const extra = await fetchFromNewsData(allKws);
    pool.push(...extra);
    if (extra.length > 0) {
      sourceStatus.push({ source: "newsdata.io:fallback", status: "ok", count: extra.length, kind: "news" });
    }
  }

  // Per-product classification
  const out = {};
  for (const key of products) {
    const kws = PRODUCT_KEYWORDS[key] || [key];
    const matched = pool.filter((a) =>
      matchProduct(`${a.title} ${a.description}`, kws)
    );

    const classified = dedupe(matched)
      .slice(0, 5)
      .map((a) => ({ ...a, timeAgo: timeAgo(a.publishedAt) }));

    // Fallback to demo articles when no real articles match this product
    out[key] = classified.length > 0 ? classified : (DEMO_NEWS[key] || []);
  }

  return out;
}
