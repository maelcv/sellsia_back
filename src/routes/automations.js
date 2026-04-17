/**
 * Automation Routes — CRUD + trigger des automations.
 *
 * Toutes les routes (sauf webhook) nécessitent requireAuth + requireWorkspaceContext.
 * Feature flag : "automations" (ignoré pour les admins).
 *
 * Routes :
 *   GET    /api/automations                        → liste
 *   POST   /api/automations                        → créer
 *   GET    /api/automations/:id                    → détail
 *   PUT    /api/automations/:id                    → modifier
 *   DELETE /api/automations/:id                    → supprimer
 *   PATCH  /api/automations/:id/toggle             → activer/désactiver
 *   POST   /api/automations/:id/run                → trigger manuel
 *   GET    /api/automations/:id/runs               → historique des runs
 *   GET    /api/automations/:id/runs/:runId        → détail d'un run
 *   POST   /api/automations/webhook/:token         → webhook externe
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { prisma } from "../prisma.js";
import { enqueueWorkflow } from "../workers/workflow-queue.js";
import { reloadAutomations } from "../workers/automation-worker.js";
import { getAllBricksForClient } from "../bricks/registry.js";
import { listAutomationMetadataOptions } from "../services/automations/integration-resolvers.js";
import {
  listTree,
  ensureWorkspaceBaseStructure,
  createWorkspacePathPolicy,
  filterTreeByPathPolicy,
} from "../services/vault/vault-service.js";
import {
  canReadAutomationsRequest,
  canWriteAutomationsRequest,
  resolveWorkspaceIdFromRequest,
} from "../services/access/workspace-capabilities.js";

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────

function canManage(req, automation) {
  if (req.user.role === "admin") return true;
  return automation.workspaceId === req.workspaceId;
}

function requireReadAccess(req, res) {
  if (canReadAutomationsRequest(req)) return true;
  res.status(403).json({ error: "Feature 'automations' non activée sur votre plan" });
  return false;
}

function requireWriteAccess(req, res) {
  if (canWriteAutomationsRequest(req)) return true;
  res.status(403).json({ error: "Écriture automations non autorisée sur votre plan" });
  return false;
}

function collectVaultHints(tree, maxResults = 200) {
  const dirHints = [];
  const fileHints = [];

  function walk(nodes = []) {
    for (const node of nodes) {
      if (!node?.path || typeof node.path !== "string") continue;
      if (node.type === "dir") {
        dirHints.push(`${node.path.replace(/\\/g, "/")}/`);
        walk(Array.isArray(node.children) ? node.children : []);
      } else if (node.type === "file") {
        fileHints.push(node.path.replace(/\\/g, "/"));
      }

      if (dirHints.length >= maxResults && fileHints.length >= maxResults) {
        return;
      }
    }
  }

  walk(tree);

  return {
    rootHints: [...new Set(dirHints)].slice(0, maxResults),
    pathSuggestions: [...new Set([...dirHints, ...fileHints])].slice(0, maxResults),
  };
}

// ── Catalogue des briques ─────────────────────────────────────────

router.get("/bricks", requireAuth, requireWorkspaceContext, (req, res) => {
  try {
    res.json({ bricks: getAllBricksForClient() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/metadata", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireReadAccess(req, res)) return;

  try {
    const workspaceId = resolveWorkspaceIdFromRequest(req);
    const metadata = await listAutomationMetadataOptions({
      workspaceId,
      userId: req.user.sub,
      userRole: req.user.role,
    });

    let vault = {
      rootHints: [],
      pathSuggestions: [],
    };

    if (req.user.role === "admin" && !workspaceId) {
      vault = {
        rootHints: ["Global/", "Workspaces/"],
        pathSuggestions: ["Global/", "Workspaces/"],
      };
    } else if (workspaceId) {
      await ensureWorkspaceBaseStructure(
        workspaceId,
        req.user.role === "admin" ? null : req.user.sub
      );

      const tree = await listTree(workspaceId, "");
      const visibleTree = req.user.role === "admin"
        ? tree
        : filterTreeByPathPolicy(
          tree,
          (await createWorkspacePathPolicy(workspaceId, req.user.sub, req.user.role)).canReadPath
        );

      vault = collectVaultHints(visibleTree, 200);
    }

    res.json({
      metadata: {
        ...metadata,
        vault,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Liste ─────────────────────────────────────────────────────────

router.get("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireReadAccess(req, res)) return;
  try {
    const workspaceId = resolveWorkspaceIdFromRequest(req);
    // Admin without explicit ?workspaceId filter → return all automations
    const where = (req.user.role === "admin" && !req.query.workspaceId) ? {} : { workspaceId };
    const automations = await prisma.automation.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json({ automations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Créer ─────────────────────────────────────────────────────────

router.post("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  try {
    const workspaceId = resolveWorkspaceIdFromRequest(req);
    const { name, description, scope, triggerType, triggerConfig, steps, definitionJson } = req.body;

    if (!name || !triggerType) {
      return res.status(400).json({ error: "name et triggerType requis" });
    }

    const automation = await prisma.automation.create({
      data: {
        name,
        description:   description || null,
        workspaceId,
        ownerId:       req.user.sub,
        scope:         scope || "workspace",
        triggerType,
        triggerConfig: JSON.stringify(triggerConfig || {}),
        steps:         JSON.stringify(steps || []),
        definitionJson: definitionJson ? JSON.stringify(definitionJson) : null,
      },
    });

    await reloadAutomations().catch(() => {});
    res.status(201).json(automation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Détail ────────────────────────────────────────────────────────

router.get("/:id", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireReadAccess(req, res)) return;
  try {
    const automation = await prisma.automation.findUnique({ where: { id: req.params.id } });
    if (!automation || !canManage(req, automation)) {
      return res.status(404).json({ error: "Automation introuvable" });
    }
    res.json(automation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Modifier ──────────────────────────────────────────────────────

router.put("/:id", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  try {
    const existing = await prisma.automation.findUnique({ where: { id: req.params.id } });
    if (!existing || !canManage(req, existing)) {
      return res.status(404).json({ error: "Automation introuvable" });
    }

    const { name, description, triggerType, triggerConfig, steps, scope, definitionJson } = req.body;
    const automation = await prisma.automation.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined           && { name }),
        ...(description !== undefined    && { description }),
        ...(triggerType !== undefined     && { triggerType }),
        ...(triggerConfig !== undefined   && { triggerConfig: JSON.stringify(triggerConfig) }),
        ...(steps !== undefined           && { steps: JSON.stringify(steps) }),
        ...(scope !== undefined           && { scope }),
        ...(definitionJson !== undefined  && { definitionJson: definitionJson ? JSON.stringify(definitionJson) : null }),
      },
    });

    await reloadAutomations().catch(() => {});
    res.json(automation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Supprimer ─────────────────────────────────────────────────────

router.delete("/:id", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  try {
    const existing = await prisma.automation.findUnique({ where: { id: req.params.id } });
    if (!existing || !canManage(req, existing)) {
      return res.status(404).json({ error: "Automation introuvable" });
    }

    await prisma.automationRun.deleteMany({ where: { automationId: req.params.id } });
    await prisma.automation.delete({ where: { id: req.params.id } });
    await reloadAutomations().catch(() => {});
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Toggle actif/inactif ─────────────────────────────────────────

router.patch("/:id/toggle", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  try {
    const existing = await prisma.automation.findUnique({ where: { id: req.params.id } });
    if (!existing || !canManage(req, existing)) {
      return res.status(404).json({ error: "Automation introuvable" });
    }

    const automation = await prisma.automation.update({
      where: { id: req.params.id },
      data: { isActive: !existing.isActive },
    });

    await reloadAutomations().catch(() => {});
    res.json({ isActive: automation.isActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trigger manuel ────────────────────────────────────────────────

router.post("/:id/run", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireWriteAccess(req, res)) return;
  try {
    const existing = await prisma.automation.findUnique({ where: { id: req.params.id } });
    if (!existing || !canManage(req, existing)) {
      return res.status(404).json({ error: "Automation introuvable" });
    }

    // Enfile le job dans BullMQ (fallback synchrone si Redis indispo)
    const jobId = await enqueueWorkflow(
      req.params.id,
      req.body || {},
      `manual:user:${req.user.sub}`
    );
    // En mode queue, on retourne immédiatement un accusé de réception
    // En mode synchrone (fallback), le run est déjà terminé — on retourne le dernier run
    if (jobId) {
      res.json({ queued: true, jobId });
    } else {
      const runs = await prisma.automationRun.findMany({
        where: { automationId: req.params.id },
        orderBy: { startedAt: "desc" },
        take: 1,
      });
      res.json(runs[0] || { queued: false });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Historique des runs ───────────────────────────────────────────

router.get("/:id/runs", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireReadAccess(req, res)) return;
  try {
    const existing = await prisma.automation.findUnique({ where: { id: req.params.id } });
    if (!existing || !canManage(req, existing)) {
      return res.status(404).json({ error: "Automation introuvable" });
    }

    const runs = await prisma.automationRun.findMany({
      where: { automationId: req.params.id },
      orderBy: { startedAt: "desc" },
      take: Number(req.query.limit) || 50,
    });
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Détail d'un run ───────────────────────────────────────────────

router.get("/:id/runs/:runId", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireReadAccess(req, res)) return;
  try {
    const run = await prisma.automationRun.findUnique({ where: { id: req.params.runId } });
    if (!run || run.automationId !== req.params.id) {
      return res.status(404).json({ error: "Run introuvable" });
    }
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook externe ───────────────────────────────────────────────
// Pas d'auth JWT — authentification via token dans l'URL

router.post("/webhook/:token", async (req, res) => {
  try {
    const automation = await prisma.automation.findFirst({
      where: {
        isActive: true,
        triggerType: "webhook",
      },
    });

    if (!automation) {
      return res.status(404).json({ error: "Aucune automation webhook active trouvée" });
    }

    // Valider le token
    let config = {};
    try {
      config = JSON.parse(automation.triggerConfig || "{}");
    } catch {
      /* ignore */
    }

    if (config.webhookToken && config.webhookToken !== req.params.token) {
      return res.status(401).json({ error: "Token invalide" });
    }

    const jobId = await enqueueWorkflow(automation.id, req.body || {}, "webhook");
    if (jobId) {
      res.json({ queued: true, jobId });
    } else {
      const runs = await prisma.automationRun.findMany({
        where: { automationId: automation.id },
        orderBy: { startedAt: "desc" },
        take: 1,
      });
      const run = runs[0];
      res.json({ runId: run?.id, status: run?.status });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validation Zapier/Make (GET retourne 200 + token)
router.get("/webhook/:token", (req, res) => {
  res.json({ ok: true, token: req.params.token });
});

export default router;
