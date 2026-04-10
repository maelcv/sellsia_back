/**
 * Price fetcher for market reports.
 * Ported from cgiraud/src/data/fetchers/prices.js — no CLI/logger coupling.
 * Uses Yahoo Finance as primary + DB-configured scrapers as secondary,
 * with historical snapshots from MarketPriceSnapshot for delta computation.
 */
import YahooFinance from "yahoo-finance2";
import { prisma } from "../../../src/prisma.js";
import { loadSourcesForWorkspace, executeScrapingSource } from "./source_engine.js";

const yahooFinance = new YahooFinance();

export const PRODUCTS_CONFIG = {
  colza: {
    name: "Colza", symbol: "ECO=F", altSymbol: "CE=F", unit: "€/t",
    exchange: "Euronext Paris", conversionFactor: 1, validRange: [100, 2000], color: "#F5A623",
  },
  soja: {
    name: "Soja", symbol: "ZS=F", unit: "$/t", exchange: "CBOT Chicago",
    conversionFactor: 36.744, divisor: 100, validRange: [200, 1000], color: "#7B9E3F",
  },
  tournesol: {
    name: "Tournesol", symbol: "ZL=F", unit: "$/t", exchange: "CBOT / Référence",
    conversionFactor: 2204.62, divisor: 100, validRange: [200, 2500], color: "#F5D020",
    note: "Estimation via huile de soja CBOT",
  },
  palme: {
    name: "Huile de Palme", symbol: "FCPO.KL", unit: "$/t", exchange: "Bursa Malaysia",
    conversionFactor: 0.22, validRange: [300, 2000], color: "#E8A838",
  },
  petrole: {
    name: "Pétrole Brent", symbol: "BZ=F", unit: "$/baril", exchange: "ICE London",
    conversionFactor: 1, validRange: [20, 250], color: "#4A4A4A",
  },
};

const DEMO_PRICES = {
  colza:     { name: "Colza",         price: 487.50, unit: "€/t",    exchange: "Euronext Paris",      color: "#F5A623" },
  soja:      { name: "Soja",          price: 378.20, unit: "$/t",    exchange: "CBOT Chicago",        color: "#7B9E3F" },
  tournesol: { name: "Tournesol",     price: 426.80, unit: "$/t",    exchange: "CBOT / Référence",    color: "#F5D020", note: "Estimation via huile de soja CBOT" },
  palme:     { name: "Huile de Palme", price: 892.40, unit: "$/t",   exchange: "Bursa Malaysia",      color: "#E8A838" },
  petrole:   { name: "Pétrole Brent",  price: 74.35,  unit: "$/baril", exchange: "ICE London",        color: "#4A4A4A" },
};

function computeDelta(current, previous) {
  if (!previous || isNaN(previous) || isNaN(current)) return { value: 0, percent: 0, direction: "stable" };
  const value = parseFloat((current - previous).toFixed(2));
  const percent = parseFloat(((value / previous) * 100).toFixed(2));
  return { value, percent, direction: value > 0 ? "up" : value < 0 ? "down" : "stable" };
}

async function loadPreviousSnapshots(workspaceId) {
  const keys = Object.keys(PRODUCTS_CONFIG);
  const out = {};
  for (const key of keys) {
    const row = await prisma.marketPriceSnapshot.findFirst({
      where: { workspaceId, productKey: key },
      orderBy: { capturedAt: "desc" },
    });
    if (row) out[key] = { price: row.price };
  }
  return out;
}

async function saveSnapshots(workspaceId, prices) {
  const entries = Object.entries(prices).filter(([, d]) => d.price != null);
  if (entries.length === 0) return;

  await prisma.marketPriceSnapshot.createMany({
    data: entries.map(([key, data]) => ({
      workspaceId,
      productKey: key,
      price: data.price,
      unit: data.unit || null,
      source: data.source || null,
    }))
  });
}

async function fetchYahooSymbol(symbol, config) {
  try {
    const result = await yahooFinance.quote(symbol, {}, { validateResult: false });
    if (!result || !result.regularMarketPrice) return null;
    let price = result.regularMarketPrice;
    if (config.divisor) price = price / config.divisor;
    price = price * config.conversionFactor;
    return parseFloat(price.toFixed(2));
  } catch {
    return null;
  }
}

/**
 * Fetch all product prices for a workspace.
 * @param {{ workspaceId: string, demoMode?: boolean, sourceStatus?: Array }} opts
 */
export async function fetchAllPrices({ workspaceId, demoMode = false, sourceStatus = [] } = {}) {
  const history = await loadPreviousSnapshots(workspaceId);

  if (demoMode) {
    const prices = {};
    for (const [key, data] of Object.entries(DEMO_PRICES)) {
      const variation = (Math.random() - 0.48) * (key === "petrole" ? 1.5 : 8);
      const price = parseFloat((data.price + variation).toFixed(2));
      prices[key] = { ...data, price, source: "demo", delta: computeDelta(price, history[key]?.price ?? data.price) };
      sourceStatus.push({ product: key, source: "demo", status: "ok" });
    }
    await saveSnapshots(workspaceId, prices);
    return prices;
  }

  const sources = await loadSourcesForWorkspace(workspaceId);
  const scrapers = sources.filter((s) => s.type === "scrapping" && (!s.content_type || s.content_type === "price"));
  const prices = {};

  for (const [key, config] of Object.entries(PRODUCTS_CONFIG)) {
    let price = null;

    // 1. DB scrapers
    for (const scraper of scrapers) {
      if (!scraper.config?.urls_to_scrape?.find?.((u) => u.id === key)) continue;
      try {
        const scraped = await executeScrapingSource(scraper, key);
        if (!scraped?.price) continue;
        const firstToken = String(scraped.price).trim().split(/[\s(+]/)[0].split("-")[0];
        let rawPrice = parseFloat(firstToken.replace(",", "."));
        if (isNaN(rawPrice) || rawPrice <= 0) continue;
        if (config.divisor) rawPrice = rawPrice / config.divisor;
        rawPrice = rawPrice * config.conversionFactor;
        const candidate = parseFloat(rawPrice.toFixed(2));
        if (config.validRange && (candidate < config.validRange[0] || candidate > config.validRange[1])) {
          sourceStatus.push({ product: key, source: scraper.id, status: "out_of_range", value: candidate });
          continue;
        }
        price = candidate;
        sourceStatus.push({ product: key, source: scraper.id, status: "ok" });
        break;
      } catch (err) {
        sourceStatus.push({ product: key, source: scraper.id, status: "error", message: err.message });
      }
    }

    // 2. Yahoo Finance fallback
    if (!price) {
      const symbols = [config.symbol, config.altSymbol].filter(Boolean);
      for (const symbol of symbols) {
        // Keep a small pacing delay, but avoid large fixed waits.
        await new Promise((r) => setTimeout(r, 120));
        const yp = await fetchYahooSymbol(symbol, config);
        if (yp == null) {
          sourceStatus.push({ product: key, source: `yahoo:${symbol}`, status: "error" });
          continue;
        }
        if (config.validRange && (yp < config.validRange[0] || yp > config.validRange[1])) {
          sourceStatus.push({ product: key, source: `yahoo:${symbol}`, status: "out_of_range", value: yp });
          continue;
        }
        price = yp;
        sourceStatus.push({ product: key, source: `yahoo:${symbol}`, status: "ok" });
        break;
      }
    }

    if (price != null) {
      prices[key] = {
        name: config.name, price, unit: config.unit, exchange: config.exchange,
        source: "yahoo-finance", color: config.color, note: config.note,
        delta: computeDelta(price, history[key]?.price),
      };
    } else {
      const lastKnown = history[key]?.price ?? null;
      prices[key] = {
        name: config.name,
        price: lastKnown,
        unit: config.unit, exchange: config.exchange,
        source: lastKnown ? "last_known" : "unavailable",
        color: config.color,
        note: lastKnown ? "⚠ Cours de J-1 (source indisponible)" : "⚠ Données indisponibles",
        delta: { value: 0, percent: 0, direction: "stable" },
      };
    }
  }

  await saveSnapshots(workspaceId, prices);
  return prices;
}
