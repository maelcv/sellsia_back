/**
 * Market Reports HTTP routes.
 * Mount at /api/market-reports.
 * All routes behind requireAuth → requireWorkspaceContext → requireFeature("market_reports").
 */
import express from "express";
import fs from "fs";
import { prisma } from "../prisma.js";
import { requireAuth, requireFeature } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import {
  enqueueGenericReport,
  enqueueUnitReport,
  rebuildWorkspaceSchedules,
} from "../workers/market-reports-worker.js";
import {
  executeScrapingSource,
  executeApiSource,
} from "../services/market/fetchers/source_engine.js";
import { seedMarketForWorkspace } from "../seed-market.js";

const router = express.Router();
router.use(requireAuth, requireWorkspaceContext, requireFeature("market_reports"));

/**
 * Resolve effective workspaceId.
 * - Regular users: req.workspaceId (set by tenant middleware)
 * - Admins (workspaceId=null): use X-Workspace-Id header, or auto-detect first workspace
 */
async function resolveWorkspaceId(req) {
  if (req.workspaceId) return req.workspaceId;
  const headerWs = req.headers["x-workspace-id"];
  if (headerWs) return headerWs;
  const ws = await prisma.workspace.findFirst({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return ws?.id || null;
}

// Inject resolved workspaceId on every request
router.use(async (req, res, next) => {
  try {
    req._resolvedWorkspaceId = await resolveWorkspaceId(req);
    if (!req._resolvedWorkspaceId) {
      return res.status(400).json({ error: "Aucun workspace disponible. Envoyez le header X-Workspace-Id." });
    }
    next();
  } catch (err) {
    next(err);
  }
});

function ws(req) {
  return req._resolvedWorkspaceId;
}

function scope(req) {
  return { workspaceId: ws(req) };
}

function isReadOnly(req) {
  return req.user?.role === "USER";
}

// ─── SEED ────────────────────────────────────────────────────────────────────
// Initialize demo clients + sources for the current workspace
router.post("/seed", async (req, res) => {
  if (isReadOnly(req)) return res.status(403).json({ error: "Lecture seule" });
  try {
    const result = await seedMarketForWorkspace(prisma, ws(req));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── CLIENTS ────────────────────────────────────────────────────────────────
router.get("/clients", async (req, res) => {
  const clients = await prisma.marketClient.findMany({
    where: scope(req),
    orderBy: { createdAt: "asc" },
  });
  res.json(clients.map((c) => ({
    ...c,
    produits: c.produits ? safeJSON(c.produits) : [],
  })));
});

router.post("/clients", async (req, res) => {
  if (isReadOnly(req)) return res.status(403).json({ error: "Lecture seule" });
  const { nom, contact, email, langue, note, produits, active } = req.body || {};
  if (!nom || !email) return res.status(400).json({ error: "nom et email requis" });
  const client = await prisma.marketClient.create({
    data: {
      workspaceId: ws(req),
      nom,
      contact: contact || null,
      email,
      langue: langue || "fr",
      note: note || null,
      produits: JSON.stringify(Array.isArray(produits) ? produits : []),
      active: active !== false,
    },
  });
  res.status(201).json(client);
});

router.patch("/clients/:id", async (req, res) => {
  if (isReadOnly(req)) return res.status(403).json({ error: "Lecture seule" });
  const existing = await prisma.marketClient.findFirst({
    where: { id: req.params.id, workspaceId: ws(req) },
  });
  if (!existing) return res.status(404).json({ error: "Client introuvable" });
  const { nom, contact, email, langue, note, produits, active } = req.body || {};
  const updated = await prisma.marketClient.update({
    where: { id: existing.id },
    data: {
      nom: nom ?? existing.nom,
      contact: contact ?? existing.contact,
      email: email ?? existing.email,
      langue: langue ?? existing.langue,
      note: note ?? existing.note,
      produits: produits !== undefined ? JSON.stringify(produits) : existing.produits,
      active: active !== undefined ? active : existing.active,
    },
  });
  res.json(updated);
});

router.delete("/clients/:id", async (req, res) => {
  if (isReadOnly(req)) return res.status(403).json({ error: "Lecture seule" });
  const existing = await prisma.marketClient.findFirst({
    where: { id: req.params.id, workspaceId: ws(req) },
  });
  if (!existing) return res.status(404).json({ error: "Client introuvable" });
  await prisma.marketClient.delete({ where: { id: existing.id } });
  res.json({ success: true });
});

// ─── SOURCES ────────────────────────────────────────────────────────────────
router.get("/sources", async (req, res) => {
  const rows = await prisma.marketSource.findMany({
    where: scope(req),
    orderBy: { label: "asc" },
  });
  res.json(rows.map((r) => ({
    ...r,
    config: safeJSON(r.configJson),
  })));
});

router.patch("/sources/:id", async (req, res) => {
  if (isReadOnly(req)) return res.status(403).json({ error: "Lecture seule" });
  const existing = await prisma.marketSource.findFirst({
    where: { id: req.params.id, workspaceId: ws(req) },
  });
  if (!existing) return res.status(404).json({ error: "Source introuvable" });
  const { label, enabled, config, contentType, type } = req.body || {};
  const updated = await prisma.marketSource.update({
    where: { id: existing.id },
    data: {
      label: label ?? existing.label,
      enabled: enabled !== undefined ? enabled : existing.enabled,
      contentType: contentType ?? existing.contentType,
      type: type ?? existing.type,
      configJson: config !== undefined ? JSON.stringify(config) : existing.configJson,
    },
  });
  res.json(updated);
});

router.post("/sources/:id/test", async (req, res) => {
  if (isReadOnly(req)) return res.status(403).json({ error: "Lecture seule" });
  const row = await prisma.marketSource.findFirst({
    where: { id: req.params.id, workspaceId: ws(req) },
  });
  if (!row) return res.status(404).json({ error: "Source introuvable" });
  const cfg = { id: row.slug, type: row.type, content_type: row.contentType, config: safeJSON(row.configJson) };
  try {
    let result;
    if (row.type === "api") result = await executeApiSource(cfg, req.body?.variables || {});
    else {
      const targetId = req.body?.targetId || cfg.config?.urls_to_scrape?.[0]?.id;
      result = await executeScrapingSource(cfg, targetId);
    }
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── RUNS ───────────────────────────────────────────────────────────────────
router.post("/runs/generic", async (req, res) => {
  const demoMode = !!req.body?.demoMode;
  enqueueGenericReport({
    workspaceId: ws(req),
    triggeredBy: "manual",
    userId: req.user?.sub,
    demoMode,
  }).catch(() => { /* already persisted */ });
  res.status(202).json({ accepted: true });
});

// Supports single clientId or array of clientIds
router.post("/runs/unit", async (req, res) => {
  const { clientId, clientIds, demoMode } = req.body || {};
  const ids = clientIds && Array.isArray(clientIds) && clientIds.length > 0
    ? clientIds
    : clientId ? [clientId] : null;
  if (!ids) return res.status(400).json({ error: "clientId ou clientIds requis" });
  for (const cid of ids) {
    enqueueUnitReport({
      workspaceId: ws(req),
      clientId: cid,
      triggeredBy: "manual",
      userId: req.user?.sub,
      demoMode: !!demoMode,
    }).catch(() => { /* already persisted */ });
  }
  res.status(202).json({ accepted: true, count: ids.length });
});

router.get("/runs", async (req, res) => {
  const runs = await prisma.marketReportRun.findMany({
    where: scope(req),
    orderBy: { startedAt: "desc" },
    take: 50,
  });
  res.json(runs);
});

router.get("/runs/:id", async (req, res) => {
  const run = await prisma.marketReportRun.findFirst({
    where: { id: req.params.id, workspaceId: ws(req) },
  });
  if (!run) return res.status(404).json({ error: "Run introuvable" });
  res.json({ ...run, payload: run.payloadJson ? safeJSON(run.payloadJson) : null });
});

router.get("/runs/:id/pdf", async (req, res) => {
  const run = await prisma.marketReportRun.findFirst({
    where: { id: req.params.id, workspaceId: ws(req) },
  });
  if (!run || !run.pdfPath || !fs.existsSync(run.pdfPath)) {
    return res.status(404).json({ error: "PDF introuvable" });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="rapport-${run.id}.pdf"`);
  fs.createReadStream(run.pdfPath).pipe(res);
});

// ─── SCHEDULES ──────────────────────────────────────────────────────────────
router.get("/schedules", async (req, res) => {
  const rows = await prisma.marketReportSchedule.findMany({ where: scope(req) });
  res.json(rows);
});

router.put("/schedules/:kind", async (req, res) => {
  if (isReadOnly(req)) return res.status(403).json({ error: "Lecture seule" });
  const { kind } = req.params;
  if (!["generic", "unit"].includes(kind)) return res.status(400).json({ error: "kind invalide" });
  const { cronExpr, enabled, timezone } = req.body || {};
  const row = await prisma.marketReportSchedule.upsert({
    where: { workspaceId_kind: { workspaceId: ws(req), kind } },
    update: {
      cronExpr: cronExpr ?? undefined,
      enabled: enabled !== undefined ? enabled : undefined,
      timezone: timezone ?? undefined,
    },
    create: {
      workspaceId: ws(req),
      kind,
      cronExpr: cronExpr || (kind === "generic" ? "0 7 * * 1-5" : "0 15 * * 1-5"),
      enabled: enabled !== false,
      timezone: timezone || "Europe/Paris",
    },
  });
  await rebuildWorkspaceSchedules(ws(req));
  res.json(row);
});

// ─── PRICE HISTORY ──────────────────────────────────────────────────────────
router.get("/prices/history", async (req, res) => {
  const { productKey, days = 30 } = req.query;
  const since = new Date(Date.now() - Number(days) * 86400000);
  const where = { workspaceId: ws(req), capturedAt: { gte: since } };
  if (productKey) where.productKey = String(productKey);
  const rows = await prisma.marketPriceSnapshot.findMany({
    where,
    orderBy: { capturedAt: "asc" },
  });
  res.json(rows);
});

// ─── CANCEL RUN ─────────────────────────────────────────────────────────────
router.post("/runs/:id/cancel", async (req, res) => {
  if (isReadOnly(req)) return res.status(403).json({ error: "Lecture seule" });

  const run = await prisma.marketReportRun.findFirst({
    where: { id: req.params.id, workspaceId: ws(req) },
  });

  if (!run) return res.status(404).json({ error: "Run introuvable" });
  if (run.status === "success" || run.status === "failed" || run.status === "cancelled") {
    return res.status(400).json({ error: "Ce rapport ne peut pas être annulé (déjà terminé)" });
  }

  // Mark as cancelled with current state
  const now = new Date();
  let payload = {};
  try { payload = JSON.parse(run.payloadJson || "{}"); } catch {}

  // Add cancellation log to steps
  const steps = payload.steps || [];
  steps.push({
    step: "cancelled",
    status: "skipped",
    detail: "Rapport annulé par l'utilisateur",
    ts: now.toISOString()
  });

  const updated = await prisma.marketReportRun.update({
    where: { id: req.params.id },
    data: {
      status: "cancelled",
      finishedAt: now,
      payloadJson: JSON.stringify({ ...payload, steps }),
    },
  });

  res.json({ success: true, status: "cancelled", run: updated });
});

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export default router;
