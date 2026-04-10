/**
 * Unit (afternoon) market report runner — per client, filtered by products.
 * Ported from cgiraud/src/commands/unit_report.js.
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../../src/prisma.js";
import { fetchAllPrices, PRODUCTS_CONFIG } from "../fetchers/prices.js";
import { fetchAllNews } from "../fetchers/news.js";
import { synthesizeAll } from "../services/mistral.js";
import { renderTemplate, generateComparisonChart } from "../services/renderer.js";
import { generatePDF } from "../services/pdf.js";
import { sendReportEmail } from "../services/mailer.js";

const STORAGE_ROOT =
  process.env.MARKET_REPORTS_STORAGE_DIR ||
  path.join(process.cwd(), "storage", "market-reports");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function todayStr() {
  return new Date().toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}
function dateShortStr() {
  return new Date().toLocaleDateString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}
function timeStr() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function parseClientProducts(client) {
  if (!client.produits) return Object.keys(PRODUCTS_CONFIG);
  try {
    const parsed = typeof client.produits === "string" ? JSON.parse(client.produits) : client.produits;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* ignore */ }
  return Object.keys(PRODUCTS_CONFIG);
}

async function logStep(runId, step, status, detail = "", logs = undefined) {
  const row = await prisma.marketReportRun.findUnique({
    where: { id: runId }, select: { payloadJson: true },
  });
  let payload = {};
  try { payload = JSON.parse(row?.payloadJson || "{}"); } catch {}
  const steps = payload.steps || [];
  const entry = { step, status, detail, ts: new Date().toISOString(), ...(logs && logs.length > 0 ? { logs } : {}) };
  const existingIdx = steps.findIndex(s => s.step === step);
  if (existingIdx >= 0) {
    steps[existingIdx] = entry;
  } else {
    steps.push(entry);
  }
  await prisma.marketReportRun.update({
    where: { id: runId },
    data: { payloadJson: JSON.stringify({ ...payload, steps }) },
  });
}

async function getSteps(runId) {
  const row = await prisma.marketReportRun.findUnique({
    where: { id: runId }, select: { payloadJson: true },
  });
  try { return JSON.parse(row?.payloadJson || "{}").steps || []; } catch { return []; }
}

/**
 * @param {{workspaceId:string, clientId:string, triggeredBy?:string, userId?:string, demoMode?:boolean, sendEmails?:boolean}} opts
 */
export async function runUnitReport({
  workspaceId,
  clientId,
  triggeredBy = "manual",
  userId = null,
  demoMode = false,
  sendEmails = true,
} = {}) {
  if (!workspaceId) throw new Error("workspaceId requis");
  if (!clientId) throw new Error("clientId requis");

  const client = await prisma.marketClient.findFirst({
    where: { id: clientId, workspaceId },
  });
  if (!client) throw new Error(`Client introuvable: ${clientId}`);

  const run = await prisma.marketReportRun.create({
    data: {
      workspaceId,
      kind: "unit",
      clientId,
      status: "running",
      triggeredBy,
      createdByUser: userId,
      startedAt: new Date(),
      payloadJson: JSON.stringify({
        steps: [{ step: "start", status: "ok", detail: `Rapport unitaire pour ${client.nom}`, ts: new Date().toISOString() }],
      }),
    },
  });

  const sourceStatus = [];
  try {
    const productKeys = parseClientProducts(client).filter((k) => PRODUCTS_CONFIG[k]);
    await logStep(run.id, "init", "ok", `Produits suivis : ${productKeys.join(", ")}`);

    // ── Step 1 + 2: Fetch prices/news in parallel ──────────────────
    await Promise.all([
      logStep(run.id, "fetch_prices", "running", "Récupération des cours en cours…"),
      logStep(run.id, "fetch_news", "running", "Récupération des actualités en cours…")
    ]);

    let prices = {};
    let news = {};
    const [pricesResult, newsResult] = await Promise.allSettled([
      fetchAllPrices({ workspaceId, demoMode, sourceStatus }),
      fetchAllNews({ workspaceId, products: productKeys, demoMode, sourceStatus })
    ]);

    if (pricesResult.status === "fulfilled") {
      prices = pricesResult.value || {};
      const count = productKeys.filter((k) => prices[k]?.price != null).length;
      const priceLogs = sourceStatus
        .filter((s) => s.product)
        .map((s) => {
          const sym = s.status === "ok" ? "✓" : "✗";
          const val = s.value != null ? ` | ${s.value.toFixed(2)} ${prices[s.product]?.unit || ""}` : "";
          return `${prices[s.product]?.name || s.product} | ${s.source}${val} ${sym}${s.message ? ` — ${s.message}` : ""}`;
        });
      await logStep(run.id, "fetch_prices", "ok", `${count}/${productKeys.length} cours récupérés`, priceLogs);
    } else {
      await logStep(run.id, "fetch_prices", "error", pricesResult.reason?.message || "Erreur inconnue");
      sourceStatus.push({ source: "prices", status: "error", message: pricesResult.reason?.message || "Erreur inconnue" });
    }

    if (newsResult.status === "fulfilled") {
      news = newsResult.value || {};
      const total = Object.values(news).reduce((s, arr) => s + (arr?.length || 0), 0);
      const newsSourceLogs = sourceStatus
        .filter((s) => s.kind === "news")
        .map((s) => `${s.source} | ${s.count != null ? s.count + " articles" : s.message || "aucun résultat"} ${s.status === "ok" ? "✓" : "✗"}`);
      const newsProductLogs = productKeys.map((key) => `${key} : ${news[key]?.length || 0} articles`);
      const newsLogs = [...newsSourceLogs, ...newsProductLogs];
      await logStep(run.id, "fetch_news", "ok", `${total} articles récupérés`, newsLogs);
    } else {
      await logStep(run.id, "fetch_news", "error", newsResult.reason?.message || "Erreur inconnue");
      sourceStatus.push({ source: "news", status: "error", message: newsResult.reason?.message || "Erreur inconnue" });
    }

    // ── Step 3: AI Synthesis ───────────────────────────────────────
    await logStep(run.id, "synthesis", "running", `Analyse IA de ${productKeys.length} produits…`);
    let synthesis = {};
    try {
      synthesis = await synthesizeAll(news, productKeys, workspaceId, { demoMode });
      const synthesisLogs = Object.entries(synthesis).map(([key, s]) =>
        s ? `${key} | ${s.tendance} | risque: ${s.niveau_risque} ✓`
          : `${key} | échec de synthèse ✗`
      );
      await logStep(run.id, "synthesis", "ok", `${Object.keys(synthesis).length} synthèses générées`, synthesisLogs);
    } catch (err) {
      await logStep(run.id, "synthesis", "error", err.message);
    }

    // ── Step 4: Build context & render ────────────────────────────
    await logStep(run.id, "render", "running", "Génération du rapport HTML…");

    const productsList = productKeys.map((key) => ({
      key,
      ...prices[key],
      news: news[key] || [],       // template expects "news" not "articles"
      synthesis: synthesis[key] || null,
    }));

    const petrolPrice = prices.petrole?.price?.toFixed(2) || null;

    const context = {
      date: todayStr(),
      dateShort: dateShortStr(),
      time: timeStr(),
      title: `Rapport Marché — ${client.nom}`,
      subtitle: "Synthèse personnalisée de l'après-midi",
      client: {
        nom: client.nom,
        contact: client.contact,
        email: client.email,
        langue: client.langue,
        note: client.note,
        produits: productKeys,    // array for template {{#each client.produits}}
      },
      productsList,               // template uses {{#each productsList}}
      comparisonChart: generateComparisonChart(productsList),
      petrolPrice,
      demoMode,
    };

    const html = renderTemplate("unit.hbs", context);
    const emailHtml = renderTemplate("email_unit.hbs", context);
    await logStep(run.id, "render", "ok", "HTML généré");

    // ── Step 5: Generate PDF ───────────────────────────────────────
    await logStep(run.id, "pdf", "running", "Génération du PDF…");
    const pdfBuffer = await generatePDF(html);
    const workspaceDir = path.join(STORAGE_ROOT, workspaceId);
    ensureDir(workspaceDir);
    const pdfPath = path.join(workspaceDir, `${run.id}.pdf`);
    await fs.promises.writeFile(pdfPath, pdfBuffer);
    await logStep(run.id, "pdf", "ok", `PDF généré (${Math.round(pdfBuffer.length / 1024)} Ko)`);

    // ── Step 6: Send email ─────────────────────────────────────────
    let emailSentAt = null;
    if (sendEmails && userId && client.email) {
      await logStep(run.id, "email", "running", `Envoi à ${client.email}…`);
      try {
        await sendReportEmail({
          userId,
          to: client.email,
          subject: `Rapport Marché — ${client.nom} — ${context.date}`,
          htmlBody: emailHtml,
          pdfBuffer,
          pdfFilename: `rapport-${client.nom.replace(/\s+/g, "_")}-${run.id}.pdf`,
        });
        emailSentAt = new Date();
        const emailLogs = [`${client.email} ✓`];
        await logStep(run.id, "email", "ok", `Email envoyé à ${client.email}`, emailLogs);
      } catch (err) {
        sourceStatus.push({ source: "mailer", status: "error", message: err.message });
        const errorLogs = [`${client.email} ✗ — ${err.message}`];
        await logStep(run.id, "email", "error", err.message, errorLogs);
      }
    } else {
      await logStep(run.id, "email", "skipped", !userId ? "userId non fourni" : "Email client manquant");
    }

    await prisma.marketReportRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        pdfPath,
        emailSentAt,
        payloadJson: JSON.stringify({
          steps: await getSteps(run.id),
          sourceStatus,
          synthesis,
          prices,
          clientId,
        }),
      },
    });

    return { runId: run.id, pdfPath, emailSentAt, sourceStatus };
  } catch (err) {
    await logStep(run.id, "fatal", "error", err.message);
    await prisma.marketReportRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: err.message,
        payloadJson: JSON.stringify({ steps: await getSteps(run.id), sourceStatus, clientId }),
      },
    });
    throw err;
  }
}
