/**
 * Handlebars renderer for market report templates.
 * Templates live at backend/ia_models/market/templates/.
 */
import Handlebars from "handlebars";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "../templates");
const CSS_PATH = path.join(TEMPLATES_DIR, "assets/style.css");

// Handlebars helpers (ported from cgiraud)
Handlebars.registerHelper("formatPrice", (price) => {
  if (price == null || isNaN(price)) return "—";
  return Number(price).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});
Handlebars.registerHelper("formatNum", (num) => {
  if (num == null || isNaN(num)) return "—";
  return Math.abs(Number(num)).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});
Handlebars.registerHelper("deltaSign", (v) => (v >= 0 ? "+" : "−"));
Handlebars.registerHelper("deltaArrow", (d) => (d === "up" ? "↑" : d === "down" ? "↓" : "→"));
Handlebars.registerHelper("trendLabel", (d) => (d === "up" ? "↑ Hausse" : d === "down" ? "↓ Baisse" : "→ Stable"));
Handlebars.registerHelper("cssClass", (s) => {
  if (!s) return "";
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
});
Handlebars.registerHelper("capitalize", (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : ""));
Handlebars.registerHelper("ifIn", function (value, array, options) {
  if (Array.isArray(array) && array.includes(value)) return options.fn(this);
  return options.inverse(this);
});
Handlebars.registerHelper("ifEqual", function (a, b, options) {
  if (a === b) return options.fn(this);
  return options.inverse(this);
});
Handlebars.registerHelper("ifGt", function (a, b, options) {
  if (Number(a) > Number(b)) return options.fn(this);
  return options.inverse(this);
});
Handlebars.registerHelper("riskCssClass", (level) => {
  const map = { faible: "faible", modéré: "modere", élevé: "eleve" };
  return map[level] || "modere";
});

// Template cache
const cache = new Map();
function compile(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(TEMPLATES_DIR, name);
  if (!fs.existsSync(file)) throw new Error(`Template introuvable: ${file}`);
  const tpl = Handlebars.compile(fs.readFileSync(file, "utf-8"));
  cache.set(name, tpl);
  return tpl;
}

let cssCache = null;
function getCss() {
  if (cssCache !== null) return cssCache;
  cssCache = fs.existsSync(CSS_PATH) ? fs.readFileSync(CSS_PATH, "utf-8") : "";
  return cssCache;
}

/**
 * Render a template by filename (e.g. "generic.hbs")
 */
export function renderTemplate(templateName, context) {
  const tpl = compile(templateName);
  return tpl({
    ...context,
    embeddedCSS: getCss(),
    logoBase64: "",
  });
}

/**
 * SVG comparison chart (inline) for multi-product unit reports.
 */
export function generateComparisonChart(productsList) {
  if (!productsList || productsList.length < 2) return "";
  const width = 520;
  const barH = 22;
  const padding = { top: 20, right: 20, bottom: 20, left: 130 };
  const maxPrice = Math.max(...productsList.map((p) => p.price || 0));
  const bars = productsList.map((p, i) => {
    const y = padding.top + i * (barH + 10);
    const barWidth = Math.max(4, ((p.price || 0) / maxPrice) * (width - padding.left - padding.right));
    const color = p.color || "#1A2E52";
    const deltaStr = p.delta ? `${p.delta.value >= 0 ? "+" : ""}${p.delta.value?.toFixed(2)}` : "";
    const dirColor = p.delta?.direction === "up" ? "#1A7A4A" : p.delta?.direction === "down" ? "#C0392B" : "#72798A";
    return `<g>
      <text x="${padding.left - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="9" font-family="Inter,sans-serif" fill="#1C2833" font-weight="600">${p.name}</text>
      <rect x="${padding.left}" y="${y}" width="${barWidth}" height="${barH}" rx="3" fill="${color}" opacity="0.85"/>
      <text x="${padding.left + barWidth + 6}" y="${y + barH / 2 + 4}" font-size="9" font-family="Inter,sans-serif" fill="#1C2833" font-weight="600">${p.price?.toFixed(2)} ${p.unit}</text>
      <text x="${padding.left + barWidth + 6}" y="${y + barH / 2 + 16}" font-size="8" font-family="Inter,sans-serif" fill="${dirColor}">${deltaStr}</text>
    </g>`;
  });
  return `<svg width="${width}" height="${padding.top + productsList.length * (barH + 10) + padding.bottom}" xmlns="http://www.w3.org/2000/svg">
    <text x="${padding.left}" y="13" font-size="8" font-family="Inter,sans-serif" fill="#72798A" font-weight="600" text-transform="uppercase" letter-spacing="0.05em">COMPARATIF DES COURS</text>
    ${bars.join("")}
  </svg>`;
}
