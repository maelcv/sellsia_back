/**
 * Source engine — executes API / scraper source configs.
 * Ported from cgiraud/src/data/fetchers/source_engine.js.
 * Now loads sources from the database (MarketSource) instead of filesystem.
 */
import fs from "fs";
import { execSync } from "child_process";
import axios from "axios";
import puppeteer from "puppeteer";
import { prisma } from "../../../src/prisma.js";

function findChromiumExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try {
    const found = execSync("which chromium-browser 2>/dev/null || which chromium 2>/dev/null", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    if (found) return found;
  } catch {}
  return undefined; // Puppeteer bundled Chrome
}

/**
 * Load enabled sources from DB for a workspace.
 * Returns array of { id, type, content_type, config } (cgiraud-compatible shape).
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
      config: cfg.config || cfg, // support both shapes
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
 * Execute a scraping source via headless Puppeteer (with optional Firecrawl fallback).
 */
export async function executeScrapingSource(sourceConfig, targetId) {
  const cfg = sourceConfig.config;
  const target = cfg.urls_to_scrape?.find((u) => u.id === targetId);
  if (!target) return null;

  const url = `${cfg.base_url.replace(/\/$/, "")}/${target.path.replace(/^\//, "")}`;
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  let rawHtml = null;

  if (firecrawlKey && !firecrawlKey.startsWith("your_")) {
    try {
      const res = await axios.post(
        "https://api.firecrawl.dev/v1/scrape",
        { url, formats: ["rawHtml"] },
        { headers: { Authorization: `Bearer ${firecrawlKey}` }, timeout: 20000 }
      );
      if (res.data?.success && res.data?.data?.rawHtml) rawHtml = res.data.data.rawHtml;
    } catch {
      // Fall through to Puppeteer
    }
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: findChromiumExecutable(),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
    });
    const page = await browser.newPage();
    if (rawHtml) {
      await page.setContent(rawHtml, { waitUntil: "domcontentloaded" });
    } else {
      if (cfg.navigation?.user_agent) await page.setUserAgent(cfg.navigation.user_agent);
      const navTimeout = cfg.navigation?.timeout || 30000;
      page.setDefaultNavigationTimeout(navTimeout);
      await page.goto(url, {
        waitUntil: cfg.navigation?.wait_until || "networkidle2",
        timeout: navTimeout,
      });
      if (cfg.navigation?.wait_for_selector) {
        await page
          .waitForSelector(cfg.navigation.wait_for_selector, { timeout: 10000 })
          .catch(() => {});
      }
    }

    return await page.evaluate((selectors) => {
      if (selectors.items) {
        const elements = Array.from(document.querySelectorAll(selectors.items)).slice(0, 5);
        return elements.map((el) => {
          const getVal = (sel, attr) => {
            if (!sel) return null;
            const t = el.matches(sel) ? el : el.querySelector(sel);
            if (!t) return null;
            return attr ? t.getAttribute(attr) : t.innerText.trim();
          };
          return {
            title: getVal(selectors.item_title) || "Sans titre",
            description: getVal(selectors.item_description) || "",
            url: getVal(selectors.item_url, "href") || window.location.href,
            source: selectors.source_name || window.location.hostname,
            publishedAt: new Date().toISOString(),
          };
        });
      }
      const getVal = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return el.innerText.trim().replace(/,(?=\d{3}(?:[.\s]|$))/g, "").replace(",", ".");
      };
      return {
        price: getVal(selectors.price),
        variation: getVal(selectors.variation),
        variation_percent: getVal(selectors.variation_percent),
      };
    }, cfg.extraction_selectors);
  } finally {
    if (browser) await browser.close().catch(() => {});
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
