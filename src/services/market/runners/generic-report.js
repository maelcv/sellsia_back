/**
 * Generic (morning) market report runner.
 * Ported from cgiraud/src/commands/generic_report.js — no CLI, no console.
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../../prisma.js";
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

/** Append a step log to the run's payloadJson */
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

/**
 * @param {{workspaceId:string, triggeredBy?:"manual"|"cron", userId?:string, demoMode?:boolean, sendEmails?:boolean}} opts
 */
export async function runGenericReport({
  workspaceId,
  triggeredBy = "manual",
  userId = null,
  demoMode = false,
  sendEmails = true,
} = {}) {
  if (!workspaceId) throw new Error("workspaceId requis");

  const run = await prisma.marketReportRun.create({
    data: {
      workspaceId,
      kind: "generic",
      status: "running",
      triggeredBy,
      createdByUser: userId,
      startedAt: new Date(),
      payloadJson: JSON.stringify({ steps: [{ step: "start", status: "ok", detail: "Démarrage du rapport matinal", ts: new Date().toISOString() }] }),
    },
  });

  const sourceStatus = [];
  try {
    // ── Step 1 + 2: Fetch prices/news in parallel ──────────────────
    await Promise.all([
      logStep(run.id, "fetch_prices", "running", "Récupération des cours en cours…"),
      logStep(run.id, "fetch_news", "running", "Récupération des actualités en cours…")
    ]);

    let prices = {};
    let news = {};
    const [pricesResult, newsResult] = await Promise.allSettled([
      fetchAllPrices({ workspaceId, demoMode, sourceStatus }),
      fetchAllNews({ workspaceId, demoMode, sourceStatus })
    ]);

    if (pricesResult.status === "fulfilled") {
      prices = pricesResult.value || {};
      const count = Object.values(prices).filter((p) => p.price != null).length;
      const priceLogs = sourceStatus
        .filter((s) => s.product)
        .map((s) => {
          const sym = s.status === "ok" ? "✓" : "✗";
          const val = s.value != null ? ` | ${s.value.toFixed(2)} ${prices[s.product]?.unit || ""}` : "";
          return `${prices[s.product]?.name || s.product} | ${s.source}${val} ${sym}${s.message ? ` — ${s.message}` : ""}`;
        });
      await logStep(run.id, "fetch_prices", "ok", `${count}/${Object.keys(PRODUCTS_CONFIG).length} cours récupérés`, priceLogs);
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
      const products = Object.keys(PRODUCTS_CONFIG);
      const newsProductLogs = products.map((key) => `${key} : ${news[key]?.length || 0} articles`);
      const newsLogs = [...newsSourceLogs, ...newsProductLogs];
      await logStep(run.id, "fetch_news", "ok", `${total} articles récupérés`, newsLogs);
    } else {
      await logStep(run.id, "fetch_news", "error", newsResult.reason?.message || "Erreur inconnue");
      sourceStatus.push({ source: "news", status: "error", message: newsResult.reason?.message || "Erreur inconnue" });
    }

    // ── Step 3: AI Synthesis ───────────────────────────────────────
    const productNames = Object.keys(PRODUCTS_CONFIG);
    await logStep(run.id, "synthesis", "running", `Analyse IA de ${productNames.length} produits…`);
    let synthesis = {};
    try {
      synthesis = await synthesizeAll(news, productNames, workspaceId, { demoMode });
      const synthesisLogs = Object.entries(synthesis).map(([key, s]) =>
        s ? `${key} | ${s.tendance} | risque: ${s.niveau_risque} ✓`
          : `${key} | échec de synthèse ✗`
      );
      await logStep(run.id, "synthesis", "ok", `${Object.keys(synthesis).length} synthèses générées`, synthesisLogs);
    } catch (err) {
      await logStep(run.id, "synthesis", "error", err.message);
    }

    // ── Step 4: Load clients ───────────────────────────────────────
    const clients = await prisma.marketClient.findMany({
      where: { workspaceId, active: true },
    });
    await logStep(run.id, "clients", "ok", `${clients.length} client(s) actif(s)`);

    // ── Step 5: Build context & render ────────────────────────────
    await logStep(run.id, "render", "running", "Génération du rapport HTML…");
    const productsList = productNames.map((key) => ({
      key,
      ...prices[key],
      news: news[key] || [],       // template expects "news" not "articles"
      synthesis: synthesis[key] || null,
    }));

    const petrolPrice = prices.petrole?.price?.toFixed(2) || null;

    const context = {
      date: todayStr(),
      dateShort: dateShortStr(),   // template uses {{dateShort}}
      time: timeStr(),             // template uses {{time}}
      title: "Rapport Marché Matinal",
      subtitle: "Synthèse quotidienne des matières premières",
      productsList,                // template uses {{#each productsList}}
      comparisonChart: generateComparisonChart(productsList),
      petrolPrice,
      clients: clients.map((c) => ({ nom: c.nom, contact: c.contact, email: c.email })),
      demoMode,
    };

    const html = renderTemplate("generic.hbs", context);
    const emailHtml = renderTemplate("email_generic.hbs", context);
    await logStep(run.id, "render", "ok", "HTML généré");

    // ── Step 6: Generate PDF ───────────────────────────────────────
    await logStep(run.id, "pdf", "running", "Génération du PDF…");
    const pdfBuffer = await generatePDF(html);
    const workspaceDir = path.join(STORAGE_ROOT, workspaceId);
    ensureDir(workspaceDir);
    const pdfPath = path.join(workspaceDir, `${run.id}.pdf`);
    await fs.promises.writeFile(pdfPath, pdfBuffer);
    await logStep(run.id, "pdf", "ok", `PDF généré (${Math.round(pdfBuffer.length / 1024)} Ko)`);

    // ── Step 7: Send emails ────────────────────────────────────────
    let emailSentAt = null;
    if (sendEmails && userId && clients.length > 0) {
      const recipients = clients.map((c) => c.email).filter(Boolean);
      if (recipients.length > 0) {
        await logStep(run.id, "email", "running", `Envoi à ${recipients.length} destinataire(s)…`);
        try {
          await sendReportEmail({
            userId,
            to: recipients.join(", "),
            subject: `Rapport Marché — ${context.date}`,
            htmlBody: emailHtml,
            pdfBuffer,
            pdfFilename: `rapport-marche-${run.id}.pdf`,
          });
          emailSentAt = new Date();
          const emailLogs = recipients.map(r => `${r} ✓`);
          await logStep(run.id, "email", "ok", `Email envoyé à : ${recipients.join(", ")}`, emailLogs);
        } catch (err) {
          sourceStatus.push({ source: "mailer", status: "error", message: err.message });
          const recipients2 = clients.map((c) => c.email).filter(Boolean);
          const errorLogs = recipients2.map(r => `${r} ✗ — ${err.message}`);
          await logStep(run.id, "email", "error", err.message, errorLogs);
        }
      }
    } else {
      await logStep(run.id, "email", "skipped", !userId ? "userId non fourni" : "Aucun client actif");
    }

    await prisma.marketReportRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        pdfPath,
        emailSentAt,
        payloadJson: JSON.stringify({ steps: await getSteps(run.id), sourceStatus, synthesis, prices }),
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
        payloadJson: JSON.stringify({ steps: await getSteps(run.id), sourceStatus }),
      },
    });
    throw err;
  }
}

async function getSteps(runId) {
  const row = await prisma.marketReportRun.findUnique({
    where: { id: runId }, select: { payloadJson: true },
  });
  try { return JSON.parse(row?.payloadJson || "{}").steps || []; } catch { return []; }
}
