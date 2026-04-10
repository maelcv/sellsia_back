/**
 * Source engine — executes API / scraper source configs.
 * Scraping uses external APIs (Firecrawl, WebScraping.ai) + cheerio for parsing.
 * Puppeteer is only used as last resort when no API key is available (local dev).
 */
import axios from "axios";
import * as cheerio from "cheerio";
import { prisma } from "../../../src/prisma.js";

/**
 * Load enabled sources from DB for a workspace.
 */
export async function loadSourcesForWorkspace(workspaceId) {
  const rows = await prisma.marketSource.findMany({
    where: { workspaceId, enabled: true },
  });
  return rows.map((r) => {
    let cfg = {};
    try { cfg = JSON.parse(r.configJson); } catch { cfg = {}; }
    return {
      id: r.slug,
      label: r.label,
      type: r.type,
      content_type: r.contentType,
      config: cfg.config || cfg,
    };
  });
}

/**
 * Execute an API source (axios GET/POST) with env-resolved auth.
 */
export async function executeApiSource(sourceConfig, variables = {}) {
  const cfg = sourceConfig.config;
  const params = { ...(cfg.params || {}) };
  const headers = { ...(cfg.headers || {}) };

  if (params.q === "{{query}}" && variables.query) params.q = variables.query;

  if (cfg.auth) {
    const keyValue = process.env[cfg.auth.env_var_name];
    if (!keyValue || keyValue.startsWith("your_")) {
      throw new Error(`Clé API manquante pour ${sourceConfig.id} (${cfg.auth.env_var_name})`);
    }
    if (cfg.auth.type === "query") params[cfg.auth.key_field] = keyValue;
    else if (cfg.auth.type === "header") headers[cfg.auth.key_field] = `Bearer ${keyValue}`;
  }

  const response = await axios({
    method: cfg.method || "GET",
    url: cfg.url,
    params,
    headers,
    timeout: 10000,
  });

  const itemsPath = cfg.mappings?.items_path;
  let items = response.data;
  if (itemsPath && items?.[itemsPath]) items = items[itemsPath];
  return items;
}

/**
 * Fetch page HTML via Firecrawl API.
 */
async function fetchViaFirecrawl(url) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key || key.startsWith("your_")) return null;
  try {
    const res = await axios.post(
      "https://api.firecrawl.dev/v1/scrape",
      { url, formats: ["rawHtml"] },
      { headers: { Authorization: `Bearer ${key}` }, timeout: 25000 }
    );
    return res.data?.success && res.data?.data?.rawHtml ? res.data.data.rawHtml : null;
  } catch {
    return null;
  }
}

/**
 * Fetch page HTML via WebScraping.ai API.
 */
async function fetchViaWebScrapingAI(url) {
  const key = process.env.WEBSCRAPING_AI_API_KEY;
  if (!key || key.startsWith("your_")) return null;
  try {
    const res = await axios.get("https://api.webscraping.ai/html", {
      params: { api_key: key, url, js: true, timeout: 15000 },
      timeout: 25000,
    });
    return typeof res.data === "string" && res.data.length > 0 ? res.data : null;
  } catch {
    return null;
  }
}

/**
 * Parse HTML with cheerio using the extraction selectors from the source config.
 * Mirrors the Puppeteer page.evaluate logic — no browser required.
 */
function parseHtmlWithCheerio(html, selectors) {
  const $ = cheerio.load(html);

  if (selectors.items) {
    const results = [];
    $(selectors.items).slice(0, 5).each((_, el) => {
      const getVal = (sel, attr) => {
        if (!sel) return null;
        const target = $(el).is(sel) ? $(el) : $(el).find(sel).first();
        if (!target.length) return null;
        return attr ? target.attr(attr) : target.text().trim();
      };
      results.push({
        title: getVal(selectors.item_title) || "Sans titre",
        description: getVal(selectors.item_description) || "",
        url: getVal(selectors.item_url, "href") || "#",
        source: selectors.source_name || "",
        publishedAt: new Date().toISOString(),
      });
    });
    return results;
  }

  // Price extraction
  const getVal = (sel) => {
    if (!sel) return null;
    const text = $(sel).first().text().trim();
    return text.replace(/,(?=\d{3}(?:[.\s]|$))/g, "").replace(",", ".") || null;
  };

  return {
    price: getVal(selectors.price),
    variation: getVal(selectors.variation),
    variation_percent: getVal(selectors.variation_percent),
  };
}

/**
 * Execute a scraping source.
 * Priority: Firecrawl → WebScraping.ai → Puppeteer (last resort, local dev only).
 */
export async function executeScrapingSource(sourceConfig, targetId) {
  const cfg = sourceConfig.config;
  const target = cfg.urls_to_scrape?.find((u) => u.id === targetId);
  if (!target) return null;

  const url = `${cfg.base_url.replace(/\/$/, "")}/${target.path.replace(/^\//, "")}`;
  const selectors = cfg.extraction_selectors;

  // 1. Try Firecrawl
  let html = await fetchViaFirecrawl(url);

  // 2. Try WebScraping.ai
  if (!html) html = await fetchViaWebScrapingAI(url);

  // 3. Parse with cheerio if any API returned HTML
  if (html) {
    try {
      return parseHtmlWithCheerio(html, selectors);
    } catch {
      return null;
    }
  }

  // 4. Last resort: Puppeteer (local dev without API keys)
  try {
    const puppeteer = await import("puppeteer");
    const browser = await puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    try {
      const page = await browser.newPage();
      if (cfg.navigation?.user_agent) await page.setUserAgent(cfg.navigation.user_agent);
      const navTimeout = cfg.navigation?.timeout || 30000;
      page.setDefaultNavigationTimeout(navTimeout);
      await page.goto(url, { waitUntil: cfg.navigation?.wait_until || "networkidle2", timeout: navTimeout });
      if (cfg.navigation?.wait_for_selector) {
        await page.waitForSelector(cfg.navigation.wait_for_selector, { timeout: 10000 }).catch(() => {});
      }
      return await page.evaluate((sel) => {
        const getVal = (s, attr) => {
          if (!s) return null;
          const t = document.querySelector(s);
          if (!t) return null;
          return attr ? t.getAttribute(attr) : t.innerText.trim().replace(/,(?=\d{3}(?:[.\s]|$))/g, "").replace(",", ".");
        };
        if (sel.items) {
          return Array.from(document.querySelectorAll(sel.items)).slice(0, 5).map((el) => ({
            title: (el.querySelector(sel.item_title) || el).innerText.trim() || "Sans titre",
            description: el.querySelector(sel.item_description)?.innerText.trim() || "",
            url: el.querySelector(sel.item_url)?.getAttribute("href") || window.location.href,
            source: sel.source_name || window.location.hostname,
            publishedAt: new Date().toISOString(),
          }));
        }
        return { price: getVal(sel.price), variation: getVal(sel.variation), variation_percent: getVal(sel.variation_percent) };
      }, selectors);
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

export function mapApiResults(rawItems, mapping) {
  if (!Array.isArray(rawItems)) return [];
  const getNested = (obj, path) => path.split(".").reduce((acc, part) => acc && acc[part], obj);
  return rawItems.map((item) => ({
    title: getNested(item, mapping.title) || "Sans titre",
    description: getNested(item, mapping.description) || "",
    url: getNested(item, mapping.url) || "#",
    source: getNested(item, mapping.source_name) || "Source",
    publishedAt: getNested(item, mapping.date) || new Date().toISOString(),
  }));
}
