/**
 * Vault Routes — API pour les notes markdown (Obsidian-style).
 *
 * Toutes les routes nécessitent requireAuth + requireWorkspaceContext.
 * Les admins peuvent spécifier ?workspaceId=... pour accéder à un vault tiers.
 * Sub-clients : lecture seule sauf si feature "vault_write" activée.
 *
 * Compatibilité Obsidian Local REST API :
 *   GET/PUT/DELETE /api/vault/obsidian/* → mêmes opérations que les routes principales
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import {
  canReadVaultRequest,
  canWriteVaultRequest,
  resolveWorkspaceIdFromRequest,
} from "../services/access/workspace-capabilities.js";
import {
  readNote,
  writeNote,
  appendNote,
  deleteNote,
  listTree,
  listRootTree,
  searchNotes,
  searchRootNotes,
  getGraph,
  getRootGraph,
  getBacklinks,
  getRootBacklinks,
  readRootNote,
  writeRootNote,
  appendRootNote,
  deleteRootNote,
  reindexVault,
  reindexRootVault,
  ensureWorkspaceBaseStructure,
  createWorkspacePathPolicy,
  filterTreeByPathPolicy,
  getUserFolderVisibility,
  setUserFolderVisibility,
  createFolder,
  createRootFolder,
  renameEntry,
  renameRootEntry,
  deleteFolderRecursive,
  deleteRootFolderRecursive,
  isWorkspaceLockedFolderPath,
  isRootLockedFolderPath,
} from "../services/vault/vault-service.js";

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Vérifie qu'on a un workspaceId résolu, sinon répond 400.
 * Retourne false si la route doit s'arrêter.
 */
function requireWorkspaceId(res, workspaceId) {
  if (!workspaceId) {
    res.status(400).json({
      error: "workspaceId requis. En tant qu'admin, passez ?workspaceId=... dans la query string."
    });
    return false;
  }
  return true;
}

/**
 * Vérifie que l'utilisateur peut lire dans le vault.
 */
function requireVaultReadAccess(req, res) {
  if (canReadVaultRequest(req)) return true;
  res.status(403).json({ error: "Accès vault non autorisé sur votre plan" });
  return false;
}

/**
 * Vérifie que l'utilisateur peut écrire dans le vault.
 */
function requireVaultWriteAccess(req, res) {
  if (canWriteVaultRequest(req)) return true;
  res.status(403).json({ error: "Écriture dans le vault non autorisée sur votre plan" });
  return false;
}

function isAdminRootScope(req) {
  return req.user?.role === "admin" && !req.query.workspaceId;
}

function normalizeVaultPath(pathValue = "") {
  return String(pathValue || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function getWorkspacePathPolicy(req) {
  const workspaceId = resolveWorkspaceIdFromRequest(req);
  if (!workspaceId) {
    throw Object.assign(new Error("workspaceId requis"), { statusCode: 400 });
  }

  await ensureWorkspaceBaseStructure(
    workspaceId,
    req.user?.role === "admin" ? null : req.user?.sub
  );

  if (req.user?.role === "admin") {
    return {
      workspaceId,
      canReadPath: () => true,
      canWritePath: () => true,
      canManageFolderPath: () => true,
      getPathOwner: () => null,
    };
  }

  const policy = await createWorkspacePathPolicy(workspaceId, req.user?.sub, req.user?.role);
  return {
    workspaceId,
    ...policy,
  };
}

function ensurePathReadAccess(res, canReadPath, notePath) {
  if (canReadPath(notePath)) return true;
  res.status(403).json({ error: "Accès interdit à ce dossier/note du vault" });
  return false;
}

function ensurePathWriteAccess(res, canWritePath, notePath) {
  if (canWritePath(notePath)) return true;
  res.status(403).json({ error: "Écriture interdite dans ce dossier du vault" });
  return false;
}

function ensureFolderManageAccess(res, canManageFolderPath, folderPath) {
  if (canManageFolderPath(folderPath)) return true;
  res.status(403).json({ error: "Gestion de dossier interdite sur ce chemin" });
  return false;
}

function decorateTreeForUi(tree, options = {}) {
  const {
    rootScope = false,
    canWritePath = () => false,
    canManageFolderPath = () => false,
    getPathOwner = () => null,
  } = options;

  function decorate(node) {
    const normalizedPath = normalizeVaultPath(node.path);
    const isDir = node.type === "dir";
    const locked = isDir
      ? (rootScope ? isRootLockedFolderPath(normalizedPath) : isWorkspaceLockedFolderPath(normalizedPath))
      : false;

    const canRename = isDir
      ? (!locked && canManageFolderPath(normalizedPath))
      : canWritePath(normalizedPath);

    const canDelete = isDir
      ? (!locked && canManageFolderPath(normalizedPath))
      : canWritePath(normalizedPath);

    const canCreateChild = isDir && !locked && canManageFolderPath(normalizedPath);
    const ownerId = isDir ? (getPathOwner(normalizedPath) || null) : null;

    return {
      ...node,
      locked,
      canRename,
      canDelete,
      canCreateChild,
      ownerId,
      children: Array.isArray(node.children) ? node.children.map(decorate) : node.children,
    };
  }

  return (tree || []).map(decorate);
}

// ── Arborescence ─────────────────────────────────────────────────

// GET /api/vault/tree?folder=Clients
router.get("/tree", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    const folder = req.query.folder || "";

    if (isAdminRootScope(req)) {
      const tree = await listRootTree(folder);
      const decoratedTree = decorateTreeForUi(tree, {
        rootScope: true,
        canWritePath: () => true,
        canManageFolderPath: () => true,
        getPathOwner: () => null,
      });
      return res.json({ tree: decoratedTree });
    }

    const {
      workspaceId,
      canReadPath,
      canWritePath,
      canManageFolderPath,
      getPathOwner,
    } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;

    const tree = await listTree(workspaceId, folder);
    const filteredTree = req.user?.role === "admin"
      ? tree
      : filterTreeByPathPolicy(tree, canReadPath);

    if (req.user?.role !== "admin" && folder && !canReadPath(folder)) {
      return res.status(403).json({ error: "Accès interdit à ce dossier du vault" });
    }

    const decoratedTree = decorateTreeForUi(filteredTree, {
      rootScope: false,
      canWritePath,
      canManageFolderPath,
      getPathOwner,
    });

    res.json({ tree: decoratedTree });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Recherche ─────────────────────────────────────────────────────

// GET /api/vault/search?q=texte
router.get("/search", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    const { q, limit } = req.query;

    if (isAdminRootScope(req)) {
      const results = await searchRootNotes(q || "", Number(limit) || 20);
      return res.json({ results });
    }

    const { workspaceId, canReadPath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;

    const rawResults = await searchNotes(workspaceId, q || "", Number(limit) || 20);
    const results = req.user?.role === "admin"
      ? rawResults
      : rawResults.filter((item) => canReadPath(item.path));

    res.json({ results });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Graphe ────────────────────────────────────────────────────────

// GET /api/vault/graph
router.get("/graph", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    if (isAdminRootScope(req)) {
      const rootGraph = await getRootGraph();
      return res.json({ nodes: rootGraph.nodes, edges: rootGraph.edges });
    }

    const { workspaceId, canReadPath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;

    const graph = await getGraph(workspaceId);
    if (req.user?.role !== "admin") {
      const allowedNodeIds = new Set(
        graph.nodes.filter((node) => canReadPath(node.id)).map((node) => node.id)
      );
      graph.nodes = graph.nodes.filter((node) => allowedNodeIds.has(node.id));
      graph.edges = graph.edges.filter(
        (edge) => allowedNodeIds.has(edge.source) && allowedNodeIds.has(edge.target)
      );
    }

    res.json(graph);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Re-indexation ─────────────────────────────────────────────────

// POST /api/vault/reindex
router.post("/reindex", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    if (isAdminRootScope(req)) {
      const result = await reindexRootVault();
      return res.json(result);
    }

    const { workspaceId } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;

    const result = await reindexVault(workspaceId);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── CRUD notes ────────────────────────────────────────────────────

// GET /api/vault/note/Clients/SELI/00-Overview.md
router.get("/note/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    const notePath = req.params[0];

    if (isAdminRootScope(req)) {
      const note = await readRootNote(notePath);
      return res.json(note);
    }

    const { workspaceId, canReadPath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathReadAccess(res, canReadPath, notePath)) return;

    const note = await readNote(workspaceId, notePath);
    res.json(note);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /api/vault/backlinks/Clients/SELI/00-Overview.md
router.get("/backlinks/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    const notePath = req.params[0];

    if (isAdminRootScope(req)) {
      const backlinks = await getRootBacklinks(notePath);
      return res.json({ backlinks });
    }

    const { workspaceId, canReadPath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathReadAccess(res, canReadPath, notePath)) return;

    const rawBacklinks = await getBacklinks(workspaceId, notePath);
    const backlinks = req.user?.role === "admin"
      ? rawBacklinks
      : rawBacklinks.filter((item) => canReadPath(item.path));

    res.json({ backlinks });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// POST /api/vault/note — { path, content }
router.post("/note", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const { path: notePath, content } = req.body;
    if (!notePath || typeof notePath !== "string") {
      return res.status(400).json({ error: "path requis" });
    }

    if (isAdminRootScope(req)) {
      const result = await writeRootNote(notePath, content || "");
      return res.status(201).json(result);
    }

    const { workspaceId, canWritePath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathWriteAccess(res, canWritePath, notePath)) return;

    const result = await writeNote(workspaceId, notePath, content || "");
    res.status(201).json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// PUT /api/vault/note/Clients/SELI/00-Overview.md — { content }
router.put("/note/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const notePath = req.params[0];
    const { content } = req.body;
    if (content === undefined) {
      return res.status(400).json({ error: "content requis" });
    }

    if (isAdminRootScope(req)) {
      const result = await writeRootNote(notePath, content);
      return res.json(result);
    }

    const { workspaceId, canWritePath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathWriteAccess(res, canWritePath, notePath)) return;

    const result = await writeNote(workspaceId, notePath, content);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// PATCH /api/vault/note/path — { append: "contenu à ajouter" }
router.patch("/note/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const notePath = req.params[0];
    const { append: appendContent } = req.body;
    if (!appendContent) {
      return res.status(400).json({ error: "append requis" });
    }

    if (isAdminRootScope(req)) {
      const result = await appendRootNote(notePath, appendContent);
      return res.json(result);
    }

    const { workspaceId, canWritePath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathWriteAccess(res, canWritePath, notePath)) return;

    const result = await appendNote(workspaceId, notePath, appendContent);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// DELETE /api/vault/note/path
router.delete("/note/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const notePath = req.params[0];

    if (isAdminRootScope(req)) {
      const result = await deleteRootNote(notePath);
      return res.json(result);
    }

    const { workspaceId, canWritePath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathWriteAccess(res, canWritePath, notePath)) return;

    const result = await deleteNote(workspaceId, notePath);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Gestion dossiers / rename ───────────────────────────────────

// POST /api/vault/folder { path }
router.post("/folder", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const folderPath = normalizeVaultPath(req.body?.path || "");
    if (!folderPath) {
      return res.status(400).json({ error: "path requis" });
    }

    if (isAdminRootScope(req)) {
      const result = await createRootFolder(folderPath, null);
      return res.status(201).json(result);
    }

    const { workspaceId, canManageFolderPath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensureFolderManageAccess(res, canManageFolderPath, folderPath)) return;

    const ownerUserId = req.user?.role === "admin" ? null : req.user?.sub;
    const result = await createFolder(workspaceId, folderPath, ownerUserId);
    res.status(201).json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// PATCH /api/vault/rename { fromPath, toPath }
router.patch("/rename", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const fromPath = normalizeVaultPath(req.body?.fromPath || "");
    const toPath = normalizeVaultPath(req.body?.toPath || "");
    if (!fromPath || !toPath) {
      return res.status(400).json({ error: "fromPath et toPath requis" });
    }

    if (isAdminRootScope(req)) {
      const result = await renameRootEntry(fromPath, toPath);
      return res.json(result);
    }

    const {
      workspaceId,
      canWritePath,
      canManageFolderPath,
    } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;

    const canManageAsFolder = canManageFolderPath(fromPath) && canManageFolderPath(toPath);
    const canManageAsFile = canWritePath(fromPath) && canWritePath(toPath);
    if (!canManageAsFolder && !canManageAsFile) {
      return res.status(403).json({ error: "Renommage interdit sur ce chemin" });
    }

    const result = await renameEntry(workspaceId, fromPath, toPath);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// DELETE /api/vault/folder/path (recursive)
router.delete("/folder/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const folderPath = normalizeVaultPath(req.params[0]);
    if (!folderPath) {
      return res.status(400).json({ error: "Chemin dossier requis" });
    }

    if (isAdminRootScope(req)) {
      const result = await deleteRootFolderRecursive(folderPath);
      return res.json(result);
    }

    const { workspaceId, canManageFolderPath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensureFolderManageAccess(res, canManageFolderPath, folderPath)) return;

    const result = await deleteFolderRecursive(workspaceId, folderPath);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Visibilité dossier utilisateur ──────────────────────────────

// GET /api/vault/user-folder-visibility?userId=123
router.get("/user-folder-visibility", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    const workspaceId = resolveWorkspaceIdFromRequest(req);
    if (!requireWorkspaceId(res, workspaceId)) return;

    const targetUserId = req.user.role === "admin"
      ? String(req.query.userId || req.user.sub)
      : String(req.user.sub);

    const visibility = await getUserFolderVisibility(workspaceId, targetUserId);
    res.json({ workspaceId, userId: targetUserId, visibility });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// PUT /api/vault/user-folder-visibility { userId?, visibility: "public"|"private" }
router.put("/user-folder-visibility", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    const workspaceId = resolveWorkspaceIdFromRequest(req);
    if (!requireWorkspaceId(res, workspaceId)) return;

    const requestedUserId = req.body?.userId;
    const targetUserId = req.user.role === "admin"
      ? String(requestedUserId || req.user.sub)
      : String(req.user.sub);

    if (req.user.role !== "admin" && requestedUserId && String(requestedUserId) !== String(req.user.sub)) {
      return res.status(403).json({ error: "Vous ne pouvez modifier que votre dossier personnel" });
    }

    const visibility = req.body?.visibility;
    if (visibility !== "public" && visibility !== "private") {
      return res.status(400).json({ error: "visibility doit être 'public' ou 'private'" });
    }

    const result = await setUserFolderVisibility(workspaceId, targetUserId, visibility);
    res.json({ workspaceId, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Compatibilité Obsidian Local REST API ─────────────────────────
// Obsidian plugin envoie GET/PUT/DELETE /vault/{path}
// On le mappe sur les mêmes handlers

router.get("/obsidian/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultReadAccess(req, res)) return;
  try {
    const notePath = req.params[0];

    if (isAdminRootScope(req)) {
      const note = await readRootNote(notePath);
      return res.type("text/markdown").send(note.content);
    }

    const { workspaceId, canReadPath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathReadAccess(res, canReadPath, notePath)) return;

    const note = await readNote(workspaceId, notePath);
    // Obsidian REST API retourne le contenu brut
    res.type("text/markdown").send(note.content);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put("/obsidian/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const notePath = req.params[0];
    const content = typeof req.body === "string" ? req.body : req.body?.content || "";

    if (isAdminRootScope(req)) {
      await writeRootNote(notePath, content);
      return res.status(204).send();
    }

    const { workspaceId, canWritePath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathWriteAccess(res, canWritePath, notePath)) return;

    await writeNote(workspaceId, notePath, content);
    res.status(204).send();
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete("/obsidian/*", requireAuth, requireWorkspaceContext, async (req, res) => {
  if (!requireVaultWriteAccess(req, res)) return;
  try {
    const notePath = req.params[0];

    if (isAdminRootScope(req)) {
      await deleteRootNote(notePath);
      return res.status(204).send();
    }

    const { workspaceId, canWritePath } = await getWorkspacePathPolicy(req);
    if (!requireWorkspaceId(res, workspaceId)) return;
    if (!ensurePathWriteAccess(res, canWritePath, notePath)) return;

    await deleteNote(workspaceId, notePath);
    res.status(204).send();
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
