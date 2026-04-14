/**
 * Vault Service — Gestion des notes markdown du vault Obsidian-style.
 *
 * Stockage hybride :
 *  - Contenu réel : filesystem à VAULT_BASE_PATH/{workspaceId}/{path}
 *  - Métadonnées  : table vault_notes (PostgreSQL) pour recherche et graphe
 *
 * Sécurité : toutes les fonctions valident que le path résolu reste bien
 * dans le dossier du workspace (protection contre path traversal).
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import matter from "gray-matter";
import { prisma } from "../../prisma.js";

const VAULT_BASE = process.env.VAULT_BASE_PATH || path.resolve("./vaults");
const GLOBAL_DIR = "Global";
const WORKSPACES_DIR = "Workspaces";
const USER_FOLDER_VISIBILITY_FILE = ".user-folders.json";
const FOLDER_OWNERS_FILE = ".folder-owners.json";
const USER_FOLDER_PUBLIC = "public";
const USER_FOLDER_PRIVATE = "private";
const WORKSPACE_LOCKED_TOP_LEVEL_FOLDERS = new Set([
  GLOBAL_DIR,
  "Agents",
  "Platform",
  "System",
  "_agents",
  "_platform",
  "_system",
]);

// ─── Helpers ────────────────────────────────────────────────────

function normalizeVaultPath(rawPath = "") {
  return String(rawPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function globalRoot() {
  return path.join(VAULT_BASE, GLOBAL_DIR);
}

function workspacesRoot() {
  return path.join(VAULT_BASE, WORKSPACES_DIR);
}

/**
 * Retourne le chemin absolu de la racine du vault pour un workspace.
 */
function workspaceRoot(workspaceId) {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const modernRoot = path.join(workspacesRoot(), normalizedWorkspaceId);
  const legacyRoot = path.join(VAULT_BASE, normalizedWorkspaceId);

  if (fsSync.existsSync(modernRoot)) return modernRoot;
  if (fsSync.existsSync(legacyRoot)) return legacyRoot;

  // New default layout is /Workspaces/:id
  return modernRoot;
}

/**
 * Résout le chemin absolu d'une note et valide qu'il ne sort pas du vault.
 * Throws si path traversal détecté.
 */
function resolveSafe(workspaceId, notePath) {
  const root = workspaceRoot(workspaceId);
  const normalizedPath = normalizeVaultPath(notePath);
  const resolved = path.resolve(root, normalizedPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw Object.assign(new Error("Chemin invalide"), { statusCode: 400 });
  }
  return resolved;
}

function resolveSafeInRoot(rootDir, relativePath) {
  const normalizedPath = normalizeVaultPath(relativePath);
  const resolved = path.resolve(rootDir, normalizedPath);
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    throw Object.assign(new Error("Chemin invalide"), { statusCode: 400 });
  }
  return resolved;
}

function userFolderVisibilityPath(workspaceId) {
  return path.join(workspaceRoot(workspaceId), USER_FOLDER_VISIBILITY_FILE);
}

async function readUserFolderVisibilityMap(workspaceId) {
  const filePath = userFolderVisibilityPath(workspaceId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const map = {};
    for (const [key, value] of Object.entries(parsed)) {
      map[String(key)] = value === USER_FOLDER_PUBLIC ? USER_FOLDER_PUBLIC : USER_FOLDER_PRIVATE;
    }
    return map;
  } catch {
    return {};
  }
}

async function writeUserFolderVisibilityMap(workspaceId, map) {
  const root = workspaceRoot(workspaceId);
  await fs.mkdir(root, { recursive: true });
  const filePath = userFolderVisibilityPath(workspaceId);
  await fs.writeFile(filePath, JSON.stringify(map, null, 2), "utf-8");
}

function folderOwnersPath(workspaceId) {
  return path.join(workspaceRoot(workspaceId), FOLDER_OWNERS_FILE);
}

async function readFolderOwnersMap(workspaceId) {
  const filePath = folderOwnersPath(workspaceId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const map = {};
    for (const [folderPath, ownerId] of Object.entries(parsed)) {
      const normalizedPath = normalizeVaultPath(folderPath);
      if (!normalizedPath) continue;
      const normalizedOwner = String(ownerId || "").trim();
      if (!normalizedOwner) continue;
      map[normalizedPath] = normalizedOwner;
    }
    return map;
  } catch {
    return {};
  }
}

async function writeFolderOwnersMap(workspaceId, map) {
  const root = workspaceRoot(workspaceId);
  await fs.mkdir(root, { recursive: true });
  const filePath = folderOwnersPath(workspaceId);
  await fs.writeFile(filePath, JSON.stringify(map, null, 2), "utf-8");
}

function getNearestFolderOwner(folderOwnersMap, inputPath) {
  const normalizedPath = normalizeVaultPath(inputPath);
  if (!normalizedPath) return null;

  const parts = normalizedPath.split("/");
  for (let i = parts.length; i > 0; i -= 1) {
    const key = parts.slice(0, i).join("/");
    if (folderOwnersMap[key]) return folderOwnersMap[key];
  }
  return null;
}

function topLevelName(inputPath) {
  return normalizeVaultPath(inputPath).split("/")[0] || "";
}

function isTopLevelFolderPath(inputPath) {
  const normalizedPath = normalizeVaultPath(inputPath);
  if (!normalizedPath) return false;
  return !normalizedPath.includes("/");
}

export function isWorkspaceLockedFolderPath(inputPath) {
  const normalizedPath = normalizeVaultPath(inputPath);
  if (!normalizedPath) return false;

  if (!isTopLevelFolderPath(normalizedPath)) return false;
  return WORKSPACE_LOCKED_TOP_LEVEL_FOLDERS.has(normalizedPath);
}

export function isRootLockedFolderPath(inputPath) {
  const normalizedPath = normalizeVaultPath(inputPath);
  if (!normalizedPath) return false;

  if (normalizedPath === GLOBAL_DIR || normalizedPath === WORKSPACES_DIR) return true;

  const parts = normalizedPath.split("/");
  // Workspace root folders are system-managed and can only disappear when the workspace is deleted.
  if (parts[0] === WORKSPACES_DIR && parts[1] && parts.length === 2) {
    return true;
  }

  if (parts[0] === WORKSPACES_DIR && parts[1] && parts[2] === GLOBAL_DIR && parts.length === 3) {
    return true;
  }

  return false;
}

async function moveFolderOwnerEntries(workspaceId, fromPath, toPath) {
  const normalizedFrom = normalizeVaultPath(fromPath);
  const normalizedTo = normalizeVaultPath(toPath);
  const map = await readFolderOwnersMap(workspaceId);
  const next = { ...map };

  for (const [key, owner] of Object.entries(map)) {
    if (key === normalizedFrom || key.startsWith(`${normalizedFrom}/`)) {
      const suffix = key.slice(normalizedFrom.length).replace(/^\//, "");
      const nextKey = normalizeVaultPath(suffix ? `${normalizedTo}/${suffix}` : normalizedTo);
      delete next[key];
      next[nextKey] = owner;
    }
  }

  await writeFolderOwnersMap(workspaceId, next);
}

async function deleteFolderOwnerEntries(workspaceId, folderPath) {
  const normalizedFolder = normalizeVaultPath(folderPath);
  const map = await readFolderOwnersMap(workspaceId);
  const next = {};

  for (const [key, owner] of Object.entries(map)) {
    if (key === normalizedFolder || key.startsWith(`${normalizedFolder}/`)) continue;
    next[key] = owner;
  }

  await writeFolderOwnersMap(workspaceId, next);
}

async function moveVisibilityEntry(workspaceId, fromPath, toPath) {
  if (!isTopLevelFolderPath(fromPath) || !isTopLevelFolderPath(toPath)) return;

  const fromKey = normalizeVaultPath(fromPath);
  const toKey = normalizeVaultPath(toPath);
  const map = await readUserFolderVisibilityMap(workspaceId);
  if (!(fromKey in map)) return;

  map[toKey] = map[fromKey];
  delete map[fromKey];
  await writeUserFolderVisibilityMap(workspaceId, map);
}

async function deleteVisibilityEntry(workspaceId, folderPath) {
  if (!isTopLevelFolderPath(folderPath)) return;

  const key = normalizeVaultPath(folderPath);
  const map = await readUserFolderVisibilityMap(workspaceId);
  if (!(key in map)) return;

  delete map[key];
  await writeUserFolderVisibilityMap(workspaceId, map);
}

export async function setFolderOwner(workspaceId, folderPath, ownerUserId) {
  const normalizedPath = normalizeVaultPath(folderPath);
  const ownerId = String(ownerUserId || "").trim();
  if (!normalizedPath || !ownerId) return;
  if (isWorkspaceLockedFolderPath(normalizedPath)) return;

  const map = await readFolderOwnersMap(workspaceId);
  map[normalizedPath] = ownerId;
  await writeFolderOwnersMap(workspaceId, map);
}

export async function ensureWorkspaceBaseStructure(workspaceId, userId = null) {
  const root = workspaceRoot(workspaceId);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, GLOBAL_DIR), { recursive: true });
  if (userId !== null && userId !== undefined) {
    await fs.mkdir(path.join(root, String(userId)), { recursive: true });
  }
}

export async function getUserFolderVisibility(workspaceId, userId) {
  const map = await readUserFolderVisibilityMap(workspaceId);
  const key = String(userId || "").trim();
  return map[key] === USER_FOLDER_PUBLIC ? USER_FOLDER_PUBLIC : USER_FOLDER_PRIVATE;
}

export async function setUserFolderVisibility(workspaceId, userId, visibility) {
  const normalizedVisibility = visibility === USER_FOLDER_PUBLIC ? USER_FOLDER_PUBLIC : USER_FOLDER_PRIVATE;
  const key = String(userId || "").trim();
  if (!key) {
    throw Object.assign(new Error("userId requis"), { statusCode: 400 });
  }

  await ensureWorkspaceBaseStructure(workspaceId, key);
  const map = await readUserFolderVisibilityMap(workspaceId);
  map[key] = normalizedVisibility;
  await writeUserFolderVisibilityMap(workspaceId, map);

  return { userId: key, visibility: normalizedVisibility };
}

export async function createWorkspacePathPolicy(workspaceId, userId, userRole) {
  const isAdmin = userRole === "admin";
  const normalizedUserId = String(userId || "").trim();
  const visibilityMap = await readUserFolderVisibilityMap(workspaceId);
  const folderOwnersMap = await readFolderOwnersMap(workspaceId);
  const isWorkspaceOwner = userRole === "client";

  const getPathOwner = (inputPath) => getNearestFolderOwner(folderOwnersMap, inputPath);

  const canReadPath = (inputPath) => {
    if (isAdmin) return true;
    if (isWorkspaceOwner) return true;

    const normalizedPath = normalizeVaultPath(inputPath);
    const topLevel = normalizedPath.split("/")[0];
    if (!topLevel) return false;
    if (topLevel === GLOBAL_DIR) return true;
    if (topLevel === normalizedUserId) return true;
    const owner = getPathOwner(normalizedPath);
    if (owner && owner === normalizedUserId) return true;
    return visibilityMap[topLevel] === USER_FOLDER_PUBLIC;
  };

  const canWritePath = (inputPath) => {
    if (isAdmin) return true;
    if (isWorkspaceOwner) return true;

    const normalizedPath = normalizeVaultPath(inputPath);
    const topLevel = normalizedPath.split("/")[0];
    if (!topLevel) return false;
    if (topLevel === GLOBAL_DIR) return true;
    if (topLevel === normalizedUserId) return true;
    const owner = getPathOwner(normalizedPath);
    return owner === normalizedUserId;
  };

  const canManageFolderPath = (inputPath) => {
    if (isAdmin) return true;

    const normalizedPath = normalizeVaultPath(inputPath);
    if (!normalizedPath) return false;
    if (isWorkspaceLockedFolderPath(normalizedPath)) return false;

    if (isWorkspaceOwner) return true;

    const topLevel = normalizedPath.split("/")[0];
    if (topLevel === normalizedUserId) return true;

    const owner = getPathOwner(normalizedPath);
    return owner === normalizedUserId;
  };

  return {
    canReadPath,
    canWritePath,
    canManageFolderPath,
    getPathOwner,
    visibilityMap,
    folderOwnersMap,
  };
}

export function filterTreeByPathPolicy(tree, canReadPath) {
  function filterNode(node) {
    if (node.type === "file") {
      return canReadPath(node.path) ? node : null;
    }

    const children = Array.isArray(node.children)
      ? node.children.map(filterNode).filter(Boolean)
      : [];

    if (canReadPath(node.path) || children.length > 0) {
      return { ...node, children };
    }
    return null;
  }

  return (tree || []).map(filterNode).filter(Boolean);
}

function toNodeName(notePath) {
  const normalizedPath = normalizeVaultPath(notePath);
  const base = normalizedPath.split("/").pop() || normalizedPath;
  return base.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

/**
 * Extrait le titre d'une note depuis le frontmatter ou le nom de fichier.
 */
function extractTitle(filePath, frontmatter = {}) {
  if (frontmatter.title) return String(frontmatter.title);
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, " ");
}

/**
 * Parse les [[wikilinks]] d'un contenu markdown.
 * @returns {string[]} chemins de liens (ex: ["Clients/SELI/00-Overview", "Meetings/2026-04-14"])
 */
function parseWikilinks(content) {
  const regex = /\[\[([^\]|#]+?)(?:\|[^\]]+)?\]\]/g;
  const links = new Set();
  let match;
  while ((match = regex.exec(content)) !== null) {
    // Normalise: trim, remplace espaces par tirets, ajoute .md si pas d'extension
    let link = match[1].trim();
    if (!path.extname(link)) link += ".md";
    links.add(link);
  }
  return [...links];
}

/**
 * Compte les mots d'un contenu (approximation).
 */
function countWords(content) {
  // Retire le frontmatter et compte les mots dans le corps
  return content
    .replace(/^---[\s\S]*?---\n?/, "")
    .split(/\s+/)
    .filter(Boolean).length;
}

// ─── Sync métadonnées DB ─────────────────────────────────────────

/**
 * Met à jour (ou crée) l'entrée VaultNote en DB pour un fichier donné.
 * Appelé automatiquement après chaque writeNote.
 */
export async function syncMetadata(workspaceId, notePath, content) {
  const parsed = matter(content);
  const frontmatter = parsed.data || {};
  const outlinks = parseWikilinks(parsed.content);
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map(String)
    : frontmatter.tags
    ? [String(frontmatter.tags)]
    : [];
  const title = extractTitle(notePath, frontmatter);
  const wordCount = countWords(content);

  // Upsert VaultNote
  await prisma.vaultNote.upsert({
    where: { workspaceId_path: { workspaceId, path: notePath } },
    create: {
      workspaceId,
      path: notePath,
      title,
      frontmatter: JSON.stringify(frontmatter),
      outlinks: JSON.stringify(outlinks),
      tags: JSON.stringify(tags),
      wordCount,
    },
    update: {
      title,
      frontmatter: JSON.stringify(frontmatter),
      outlinks: JSON.stringify(outlinks),
      tags: JSON.stringify(tags),
      wordCount,
    },
  });

  // Mettre à jour les inlinks des notes cibles
  // (backlinks : les notes qui ont notePath dans leurs inlinks)
  for (const targetPath of outlinks) {
    try {
      await prisma.vaultNote.upsert({
        where: { workspaceId_path: { workspaceId, path: targetPath } },
        create: {
          workspaceId,
          path: targetPath,
          title: extractTitle(targetPath),
          inlinks: JSON.stringify([notePath]),
        },
        update: {
          inlinks: {
            // On récupère puis merge pour éviter les doublons
            set: undefined, // handled below
          },
        },
      }).then(async (existing) => {
        const current = JSON.parse(existing.inlinks || "[]");
        if (!current.includes(notePath)) {
          await prisma.vaultNote.update({
            where: { workspaceId_path: { workspaceId, path: targetPath } },
            data: { inlinks: JSON.stringify([...current, notePath]) },
          });
        }
      });
    } catch {
      // Note cible pas encore créée — inlinks seront mis à jour à sa création
    }
  }
}

// ─── CRUD ────────────────────────────────────────────────────────

/**
 * Lit le contenu d'une note.
 * @returns {{ content: string, frontmatter: object, title: string, path: string }}
 */
export async function readNote(workspaceId, notePath) {
  const filePath = resolveSafe(workspaceId, notePath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = matter(raw);
    return {
      path: notePath,
      content: raw,
      body: parsed.content,
      frontmatter: parsed.data || {},
      title: extractTitle(notePath, parsed.data),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      throw Object.assign(new Error("Note introuvable"), { statusCode: 404 });
    }
    throw err;
  }
}

/**
 * Crée ou met à jour une note (upsert).
 * Crée les dossiers parents si nécessaires.
 */
export async function writeNote(workspaceId, notePath, content) {
  const filePath = resolveSafe(workspaceId, notePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  await syncMetadata(workspaceId, notePath, content);
  return { path: notePath, written: true };
}

/**
 * Ajoute du contenu à la fin d'une note existante.
 * Crée la note si elle n'existe pas.
 */
export async function appendNote(workspaceId, notePath, appendContent) {
  const filePath = resolveSafe(workspaceId, notePath);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const newContent = existing
    ? existing.trimEnd() + "\n\n" + appendContent
    : appendContent;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, newContent, "utf-8");
  await syncMetadata(workspaceId, notePath, newContent);
  return { path: notePath, appended: true };
}

/**
 * Supprime une note (fichier + entrée DB).
 */
export async function deleteNote(workspaceId, notePath) {
  const filePath = resolveSafe(workspaceId, notePath);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  await prisma.vaultNote.deleteMany({
    where: { workspaceId, path: notePath },
  });
  // Nettoyer les inlinks pointant vers cette note
  const notes = await prisma.vaultNote.findMany({
    where: { workspaceId },
    select: { path: true, inlinks: true },
  });
  for (const note of notes) {
    const inlinks = JSON.parse(note.inlinks || "[]");
    if (inlinks.includes(notePath)) {
      await prisma.vaultNote.update({
        where: { workspaceId_path: { workspaceId, path: note.path } },
        data: { inlinks: JSON.stringify(inlinks.filter((l) => l !== notePath)) },
      });
    }
  }
  return { deleted: true };
}

async function pathExists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function rebuildWorkspaceMetadata(workspaceId) {
  await prisma.vaultNote.deleteMany({ where: { workspaceId } });
  await reindexVault(workspaceId);
}

export async function createFolder(workspaceId, folderPath, ownerUserId = null) {
  const normalizedPath = normalizeVaultPath(folderPath);
  if (!normalizedPath) {
    throw Object.assign(new Error("Chemin dossier requis"), { statusCode: 400 });
  }

  if (isWorkspaceLockedFolderPath(normalizedPath)) {
    throw Object.assign(new Error("Ce dossier est protégé"), { statusCode: 403 });
  }

  const targetPath = resolveSafe(workspaceId, normalizedPath);
  await fs.mkdir(targetPath, { recursive: true });

  if (ownerUserId !== null && ownerUserId !== undefined) {
    await setFolderOwner(workspaceId, normalizedPath, ownerUserId);
  }

  return { path: normalizedPath, created: true, type: "dir" };
}

export async function renameEntry(workspaceId, fromPath, toPath) {
  const normalizedFrom = normalizeVaultPath(fromPath);
  const normalizedTo = normalizeVaultPath(toPath);

  if (!normalizedFrom || !normalizedTo) {
    throw Object.assign(new Error("fromPath et toPath requis"), { statusCode: 400 });
  }

  if (normalizedFrom === normalizedTo) {
    return { renamed: false, path: normalizedTo };
  }

  const sourcePath = resolveSafe(workspaceId, normalizedFrom);
  const targetPath = resolveSafe(workspaceId, normalizedTo);

  if (!(await pathExists(sourcePath))) {
    throw Object.assign(new Error("Élément introuvable"), { statusCode: 404 });
  }

  if (await pathExists(targetPath)) {
    throw Object.assign(new Error("Un élément existe déjà à ce chemin"), { statusCode: 409 });
  }

  const sourceStats = await fs.stat(sourcePath);
  if (sourceStats.isDirectory() && isWorkspaceLockedFolderPath(normalizedFrom)) {
    throw Object.assign(new Error("Ce dossier est protégé"), { statusCode: 403 });
  }
  if (isWorkspaceLockedFolderPath(normalizedTo)) {
    throw Object.assign(new Error("Chemin cible protégé"), { statusCode: 403 });
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rename(sourcePath, targetPath);

  if (sourceStats.isDirectory()) {
    await moveFolderOwnerEntries(workspaceId, normalizedFrom, normalizedTo);
    await moveVisibilityEntry(workspaceId, normalizedFrom, normalizedTo);
  }

  await rebuildWorkspaceMetadata(workspaceId);

  return {
    renamed: true,
    type: sourceStats.isDirectory() ? "dir" : "file",
    fromPath: normalizedFrom,
    toPath: normalizedTo,
  };
}

export async function deleteFolderRecursive(workspaceId, folderPath) {
  const normalizedPath = normalizeVaultPath(folderPath);
  if (!normalizedPath) {
    throw Object.assign(new Error("Chemin dossier requis"), { statusCode: 400 });
  }

  if (isWorkspaceLockedFolderPath(normalizedPath)) {
    throw Object.assign(new Error("Ce dossier est protégé"), { statusCode: 403 });
  }

  const targetPath = resolveSafe(workspaceId, normalizedPath);
  if (!(await pathExists(targetPath))) {
    throw Object.assign(new Error("Dossier introuvable"), { statusCode: 404 });
  }

  const stats = await fs.stat(targetPath);
  if (!stats.isDirectory()) {
    throw Object.assign(new Error("Le chemin cible n'est pas un dossier"), { statusCode: 400 });
  }

  await fs.rm(targetPath, { recursive: true, force: true });
  await deleteFolderOwnerEntries(workspaceId, normalizedPath);
  await deleteVisibilityEntry(workspaceId, normalizedPath);
  await rebuildWorkspaceMetadata(workspaceId);

  return { deleted: true, type: "dir", path: normalizedPath };
}

// ─── Arborescence ────────────────────────────────────────────────

/**
 * Retourne l'arborescence récursive du vault (ou d'un sous-dossier).
 * @returns {{ name, path, type: "file"|"dir", children? }[]}
 */
export async function listTree(workspaceId, folder = "") {
  const root = workspaceRoot(workspaceId);
  const normalizedFolder = normalizeVaultPath(folder);
  const base = normalizedFolder ? resolveSafe(workspaceId, normalizedFolder) : root;

  // Structure attendue du workspace
  await ensureWorkspaceBaseStructure(workspaceId);

  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue; // ignorer fichiers cachés
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const children = await walk(path.join(dir, entry.name), relPath);
        nodes.push({ name: entry.name, path: relPath, type: "dir", children });
      } else if (entry.name.endsWith(".md")) {
        nodes.push({ name: entry.name, path: relPath, type: "file" });
      }
    }
    return nodes;
  }

  return walk(base, normalizedFolder || "");
}

function resolveRootScopedPath(inputPath) {
  const normalizedPath = normalizeVaultPath(inputPath);
  if (!normalizedPath) {
    throw Object.assign(new Error("path requis"), { statusCode: 400 });
  }

  if (normalizedPath === GLOBAL_DIR || normalizedPath.startsWith(`${GLOBAL_DIR}/`)) {
    const notePath = normalizedPath.slice(GLOBAL_DIR.length).replace(/^\//, "");
    return { scope: "global", notePath };
  }

  if (normalizedPath === WORKSPACES_DIR || normalizedPath.startsWith(`${WORKSPACES_DIR}/`)) {
    const parts = normalizedPath.split("/");
    const workspaceId = parts[1];
    if (!workspaceId) {
      throw Object.assign(new Error("workspaceId manquant dans le path"), { statusCode: 400 });
    }
    const notePath = parts.slice(2).join("/");
    return { scope: "workspace", workspaceId, notePath };
  }

  throw Object.assign(
    new Error("Path racine invalide. Utilisez 'Global/...' ou 'Workspaces/:workspaceId/...'."),
    { statusCode: 400 }
  );
}

async function readNoteFromRootDir(rootDir, notePath, outputPathPrefix = "") {
  const safePath = resolveSafeInRoot(rootDir, notePath);
  try {
    const raw = await fs.readFile(safePath, "utf-8");
    const parsed = matter(raw);
    const normalizedOutputPath = normalizeVaultPath(outputPathPrefix ? `${outputPathPrefix}/${notePath}` : notePath);

    return {
      path: normalizedOutputPath,
      content: raw,
      body: parsed.content,
      frontmatter: parsed.data || {},
      title: extractTitle(normalizedOutputPath, parsed.data),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      throw Object.assign(new Error("Note introuvable"), { statusCode: 404 });
    }
    throw err;
  }
}

async function writeNoteInRootDir(rootDir, notePath, content) {
  const safePath = resolveSafeInRoot(rootDir, notePath);
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, content, "utf-8");
}

async function appendNoteInRootDir(rootDir, notePath, appendContent) {
  const safePath = resolveSafeInRoot(rootDir, notePath);
  let existing = "";
  try {
    existing = await fs.readFile(safePath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const nextContent = existing
    ? `${existing.trimEnd()}\n\n${appendContent}`
    : appendContent;

  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, nextContent, "utf-8");
}

async function deleteNoteInRootDir(rootDir, notePath) {
  const safePath = resolveSafeInRoot(rootDir, notePath);
  try {
    await fs.unlink(safePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function createFolderInRootDir(rootDir, folderPath) {
  const safePath = resolveSafeInRoot(rootDir, folderPath);
  await fs.mkdir(safePath, { recursive: true });
}

async function renameEntryInRootDir(rootDir, fromPath, toPath) {
  const normalizedFrom = normalizeVaultPath(fromPath);
  const normalizedTo = normalizeVaultPath(toPath);

  if (!normalizedFrom || !normalizedTo) {
    throw Object.assign(new Error("fromPath et toPath requis"), { statusCode: 400 });
  }

  if (normalizedFrom === normalizedTo) {
    return { renamed: false, path: normalizedTo };
  }

  const sourcePath = resolveSafeInRoot(rootDir, normalizedFrom);
  const targetPath = resolveSafeInRoot(rootDir, normalizedTo);

  if (!(await pathExists(sourcePath))) {
    throw Object.assign(new Error("Élément introuvable"), { statusCode: 404 });
  }

  if (await pathExists(targetPath)) {
    throw Object.assign(new Error("Un élément existe déjà à ce chemin"), { statusCode: 409 });
  }

  const sourceStats = await fs.stat(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rename(sourcePath, targetPath);

  return {
    renamed: true,
    type: sourceStats.isDirectory() ? "dir" : "file",
    fromPath: normalizedFrom,
    toPath: normalizedTo,
  };
}

export async function createRootFolder(rootPath, ownerUserId = null) {
  if (isRootLockedFolderPath(rootPath)) {
    throw Object.assign(new Error("Ce dossier est protégé"), { statusCode: 403 });
  }

  const target = resolveRootScopedPath(rootPath);

  if (target.scope === "global") {
    if (!target.notePath) {
      await fs.mkdir(globalRoot(), { recursive: true });
      return { path: GLOBAL_DIR, created: true, type: "dir" };
    }
    await fs.mkdir(globalRoot(), { recursive: true });
    await createFolderInRootDir(globalRoot(), target.notePath);
    return { path: normalizeVaultPath(rootPath), created: true, type: "dir" };
  }

  if (!target.notePath) {
    await ensureWorkspaceBaseStructure(target.workspaceId, ownerUserId);
    return { path: normalizeVaultPath(rootPath), created: true, type: "dir" };
  }

  const folder = await createFolder(target.workspaceId, target.notePath, ownerUserId);
  return {
    ...folder,
    path: normalizeVaultPath(`${WORKSPACES_DIR}/${target.workspaceId}/${folder.path}`),
  };
}

export async function renameRootEntry(fromRootPath, toRootPath) {
  if (isRootLockedFolderPath(fromRootPath) || isRootLockedFolderPath(toRootPath)) {
    throw Object.assign(new Error("Ce dossier est protégé"), { statusCode: 403 });
  }

  const source = resolveRootScopedPath(fromRootPath);
  const target = resolveRootScopedPath(toRootPath);

  if (source.scope !== target.scope) {
    throw Object.assign(new Error("Le déplacement entre scopes racine différents est interdit"), { statusCode: 400 });
  }

  if (source.scope === "workspace" && source.workspaceId !== target.workspaceId) {
    throw Object.assign(new Error("Le déplacement entre workspaces est interdit"), { statusCode: 400 });
  }

  if (source.scope === "global") {
    if (!source.notePath || !target.notePath) {
      throw Object.assign(new Error("Impossible de renommer les dossiers racine système"), { statusCode: 403 });
    }
    const renamed = await renameEntryInRootDir(globalRoot(), source.notePath, target.notePath);
    return {
      ...renamed,
      fromPath: normalizeVaultPath(fromRootPath),
      toPath: normalizeVaultPath(toRootPath),
    };
  }

  if (!source.notePath || !target.notePath) {
    throw Object.assign(new Error("Impossible de renommer la racine d'un workspace"), { statusCode: 403 });
  }

  const renamed = await renameEntry(source.workspaceId, source.notePath, target.notePath);
  return {
    ...renamed,
    fromPath: normalizeVaultPath(fromRootPath),
    toPath: normalizeVaultPath(toRootPath),
  };
}

export async function deleteRootFolderRecursive(rootPath) {
  if (isRootLockedFolderPath(rootPath)) {
    throw Object.assign(new Error("Ce dossier est protégé"), { statusCode: 403 });
  }

  const target = resolveRootScopedPath(rootPath);

  if (target.scope === "global") {
    if (!target.notePath) {
      throw Object.assign(new Error("Impossible de supprimer la racine Global"), { statusCode: 403 });
    }

    const absPath = resolveSafeInRoot(globalRoot(), target.notePath);
    if (!(await pathExists(absPath))) {
      throw Object.assign(new Error("Dossier introuvable"), { statusCode: 404 });
    }

    const stats = await fs.stat(absPath);
    if (!stats.isDirectory()) {
      throw Object.assign(new Error("Le chemin cible n'est pas un dossier"), { statusCode: 400 });
    }

    await fs.rm(absPath, { recursive: true, force: true });
    return { deleted: true, type: "dir", path: normalizeVaultPath(rootPath) };
  }

  if (!target.notePath) {
    throw Object.assign(new Error("Impossible de supprimer la racine d'un workspace"), { statusCode: 403 });
  }

  return deleteFolderRecursive(target.workspaceId, target.notePath);
}

async function listWorkspaceIdsFromFilesystem() {
  const ids = new Set();
  await fs.mkdir(VAULT_BASE, { recursive: true });

  // Legacy layout: /vaults/:workspaceId
  try {
    const legacyEntries = await fs.readdir(VAULT_BASE, { withFileTypes: true });
    for (const entry of legacyEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === GLOBAL_DIR || entry.name === WORKSPACES_DIR) continue;
      ids.add(entry.name);
    }
  } catch {
    /* ignore */
  }

  // Modern layout: /vaults/Workspaces/:workspaceId
  const wsRoot = workspacesRoot();
  try {
    await fs.mkdir(wsRoot, { recursive: true });
    const modernEntries = await fs.readdir(wsRoot, { withFileTypes: true });
    for (const entry of modernEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      ids.add(entry.name);
    }
  } catch {
    /* ignore */
  }

  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function collectMarkdownFiles(rootDir, pathPrefix = "") {
  const files = [];

  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(absPath, relPath);
        continue;
      }

      if (!entry.name.endsWith(".md")) continue;

      try {
        const content = await fs.readFile(absPath, "utf-8");
        const fullPath = normalizeVaultPath(pathPrefix ? `${pathPrefix}/${relPath}` : relPath);
        files.push({ path: fullPath, content });
      } catch {
        /* ignore broken files */
      }
    }
  }

  await walk(rootDir, "");
  return files;
}

async function walkTreeWithPrefix(dir, prefix = "") {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const relPath = normalizeVaultPath(prefix ? `${prefix}/${entry.name}` : entry.name);
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = await walkTreeWithPrefix(absPath, relPath);
      nodes.push({ name: entry.name, path: relPath, type: "dir", children });
    } else if (entry.name.endsWith(".md")) {
      nodes.push({ name: entry.name, path: relPath, type: "file" });
    }
  }
  return nodes;
}

export async function listRootTree(folder = "") {
  const normalizedFolder = normalizeVaultPath(folder);
  await fs.mkdir(VAULT_BASE, { recursive: true });
  await fs.mkdir(globalRoot(), { recursive: true });
  await fs.mkdir(workspacesRoot(), { recursive: true });

  if (!normalizedFolder) {
    const workspaceIds = await listWorkspaceIdsFromFilesystem();
    const workspaceNodes = [];

    for (const workspaceId of workspaceIds) {
      await ensureWorkspaceBaseStructure(workspaceId);
      const wsRoot = workspaceRoot(workspaceId);
      const children = await walkTreeWithPrefix(wsRoot, `${WORKSPACES_DIR}/${workspaceId}`);
      workspaceNodes.push({
        name: workspaceId,
        path: `${WORKSPACES_DIR}/${workspaceId}`,
        type: "dir",
        children,
      });
    }

    const globalChildren = await walkTreeWithPrefix(globalRoot(), GLOBAL_DIR);
    return [
      { name: GLOBAL_DIR, path: GLOBAL_DIR, type: "dir", children: globalChildren },
      { name: WORKSPACES_DIR, path: WORKSPACES_DIR, type: "dir", children: workspaceNodes },
    ];
  }

  if (normalizedFolder === GLOBAL_DIR || normalizedFolder.startsWith(`${GLOBAL_DIR}/`)) {
    const innerFolder = normalizedFolder.slice(GLOBAL_DIR.length).replace(/^\//, "");
    const baseDir = resolveSafeInRoot(globalRoot(), innerFolder || "");
    return walkTreeWithPrefix(baseDir, normalizeVaultPath(innerFolder ? `${GLOBAL_DIR}/${innerFolder}` : GLOBAL_DIR));
  }

  if (normalizedFolder === WORKSPACES_DIR || normalizedFolder.startsWith(`${WORKSPACES_DIR}/`)) {
    const parts = normalizedFolder.split("/");

    if (parts.length === 1) {
      const workspaceIds = await listWorkspaceIdsFromFilesystem();
      return workspaceIds.map((workspaceId) => ({
        name: workspaceId,
        path: `${WORKSPACES_DIR}/${workspaceId}`,
        type: "dir",
        children: [],
      }));
    }

    const workspaceId = parts[1];
    await ensureWorkspaceBaseStructure(workspaceId);
    const wsRoot = workspaceRoot(workspaceId);
    const innerFolder = parts.slice(2).join("/");
    const baseDir = resolveSafeInRoot(wsRoot, innerFolder || "");
    const prefix = normalizeVaultPath(innerFolder
      ? `${WORKSPACES_DIR}/${workspaceId}/${innerFolder}`
      : `${WORKSPACES_DIR}/${workspaceId}`
    );
    return walkTreeWithPrefix(baseDir, prefix);
  }

  throw Object.assign(
    new Error("Folder racine invalide. Utilisez 'Global' ou 'Workspaces'."),
    { statusCode: 400 }
  );
}

export async function readRootNote(rootPath) {
  const target = resolveRootScopedPath(rootPath);

  if (target.scope === "global") {
    return readNoteFromRootDir(globalRoot(), target.notePath, GLOBAL_DIR);
  }

  const note = await readNote(target.workspaceId, target.notePath);
  return {
    ...note,
    path: normalizeVaultPath(`${WORKSPACES_DIR}/${target.workspaceId}/${target.notePath}`),
    title: extractTitle(`${WORKSPACES_DIR}/${target.workspaceId}/${target.notePath}`, note.frontmatter || {}),
  };
}

export async function writeRootNote(rootPath, content) {
  const target = resolveRootScopedPath(rootPath);

  if (target.scope === "global") {
    await fs.mkdir(globalRoot(), { recursive: true });
    await writeNoteInRootDir(globalRoot(), target.notePath, content || "");
    return { path: normalizeVaultPath(rootPath), written: true };
  }

  await ensureWorkspaceBaseStructure(target.workspaceId);
  await writeNote(target.workspaceId, target.notePath, content || "");
  return { path: normalizeVaultPath(rootPath), written: true };
}

export async function appendRootNote(rootPath, appendContent) {
  const target = resolveRootScopedPath(rootPath);

  if (target.scope === "global") {
    await fs.mkdir(globalRoot(), { recursive: true });
    await appendNoteInRootDir(globalRoot(), target.notePath, appendContent || "");
    return { path: normalizeVaultPath(rootPath), appended: true };
  }

  await ensureWorkspaceBaseStructure(target.workspaceId);
  await appendNote(target.workspaceId, target.notePath, appendContent || "");
  return { path: normalizeVaultPath(rootPath), appended: true };
}

export async function deleteRootNote(rootPath) {
  const target = resolveRootScopedPath(rootPath);

  if (target.scope === "global") {
    await deleteNoteInRootDir(globalRoot(), target.notePath);
    return { deleted: true };
  }

  return deleteNote(target.workspaceId, target.notePath);
}

export async function searchRootNotes(query, limit = 20) {
  if (!query?.trim()) return [];
  const q = query.toLowerCase();
  const max = Number(limit) > 0 ? Number(limit) : 20;
  const results = [];

  // Global files
  const globalFiles = await collectMarkdownFiles(globalRoot(), GLOBAL_DIR);
  for (const file of globalFiles) {
    if (results.length >= max) break;
    if (!file.content.toLowerCase().includes(q) && !file.path.toLowerCase().includes(q)) continue;
    const parsed = matter(file.content);
    const body = parsed.content || "";
    const idx = body.toLowerCase().indexOf(q);
    const excerpt = idx >= 0
      ? body.slice(Math.max(0, idx - 60), idx + 120).trim()
      : body.slice(0, 150).trim();
    const score = file.path.toLowerCase().includes(q) ? 1 : 0.6;
    results.push({ path: file.path, title: extractTitle(file.path, parsed.data), excerpt, score });
  }

  // Workspace files through metadata-driven search
  const workspaceIds = await listWorkspaceIdsFromFilesystem();
  for (const workspaceId of workspaceIds) {
    if (results.length >= max) break;
    try {
      const wsResults = await searchNotes(workspaceId, query, max);
      for (const result of wsResults) {
        if (results.length >= max) break;
        results.push({
          ...result,
          path: normalizeVaultPath(`${WORKSPACES_DIR}/${workspaceId}/${result.path}`),
          score: Math.max(0.4, Number(result.score || 0)),
        });
      }
    } catch {
      /* ignore malformed workspace */
    }
  }

  return results
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, max);
}

export async function getRootGraph() {
  const nodes = [];
  const edges = [];
  const pathSet = new Set();
  const titleByPath = new Map();

  const globalFiles = await collectMarkdownFiles(globalRoot(), GLOBAL_DIR);
  for (const file of globalFiles) {
    const parsed = matter(file.content);
    const title = extractTitle(file.path, parsed.data);
    nodes.push({ id: file.path, title, group: GLOBAL_DIR });
    pathSet.add(file.path);
    titleByPath.set(file.path, title);
  }

  const workspaceIds = await listWorkspaceIdsFromFilesystem();
  for (const workspaceId of workspaceIds) {
    try {
      const graph = await getGraph(workspaceId);
      for (const node of graph.nodes) {
        const scopedPath = normalizeVaultPath(`${WORKSPACES_DIR}/${workspaceId}/${node.id}`);
        nodes.push({ id: scopedPath, title: node.title || toNodeName(scopedPath), group: `${WORKSPACES_DIR}/${workspaceId}` });
        pathSet.add(scopedPath);
        titleByPath.set(scopedPath, node.title || toNodeName(scopedPath));
      }

      for (const edge of graph.edges) {
        const source = normalizeVaultPath(`${WORKSPACES_DIR}/${workspaceId}/${edge.source}`);
        const target = normalizeVaultPath(`${WORKSPACES_DIR}/${workspaceId}/${edge.target}`);
        edges.push({ source, target });
      }
    } catch {
      /* ignore malformed workspace */
    }
  }

  // Build global edges from wikilinks
  for (const file of globalFiles) {
    const parsed = matter(file.content);
    const outlinks = parseWikilinks(parsed.content || "");
    for (const rawTarget of outlinks) {
      const scopedTarget = normalizeVaultPath(
        rawTarget.startsWith(`${GLOBAL_DIR}/`) || rawTarget.startsWith(`${WORKSPACES_DIR}/`)
          ? rawTarget
          : `${GLOBAL_DIR}/${rawTarget}`
      );
      if (pathSet.has(scopedTarget)) {
        edges.push({ source: file.path, target: scopedTarget });
      }
    }
  }

  return { nodes, edges, titleByPath };
}

export async function getRootBacklinks(rootPath) {
  const normalizedPath = normalizeVaultPath(rootPath);
  const graph = await getRootGraph();
  const backlinks = [];

  for (const edge of graph.edges) {
    if (edge.target !== normalizedPath) continue;
    backlinks.push({
      path: edge.source,
      title: graph.titleByPath.get(edge.source) || toNodeName(edge.source),
    });
  }

  return backlinks;
}

export async function reindexRootVault() {
  const workspaceIds = await listWorkspaceIdsFromFilesystem();
  let total = 0;

  for (const workspaceId of workspaceIds) {
    try {
      const result = await reindexVault(workspaceId);
      total += Number(result.reindexed || 0);
    } catch {
      /* ignore per-workspace failures */
    }
  }

  return { reindexed: total, workspaces: workspaceIds.length };
}

// ─── Recherche ───────────────────────────────────────────────────

/**
 * Recherche full-text dans les notes du vault.
 * Cherche d'abord en DB (titre/tags), puis lit les fichiers pour body search.
 * @returns {{ path, title, excerpt, score }[]}
 */
export async function searchNotes(workspaceId, query, limit = 20) {
  if (!query?.trim()) return [];
  const q = query.toLowerCase();

  // 1. Chercher dans les métadonnées DB
  const notes = await prisma.vaultNote.findMany({
    where: {
      workspaceId,
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { tags: { contains: q } },
        { path: { contains: q } },
      ],
    },
    take: limit,
    orderBy: { updatedAt: "desc" },
  });

  // 2. Enrichir avec contenu fichier pour l'extrait
  const results = [];
  for (const note of notes) {
    try {
      const filePath = resolveSafe(workspaceId, note.path);
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = matter(raw);
      const body = parsed.content.toLowerCase();
      const idx = body.indexOf(q);
      const excerpt =
        idx >= 0
          ? parsed.content.slice(Math.max(0, idx - 60), idx + 120).trim()
          : parsed.content.slice(0, 150).trim();
      const score = note.title.toLowerCase().includes(q) ? 1.0 : 0.6;
      results.push({ path: note.path, title: note.title, excerpt, score });
    } catch {
      results.push({ path: note.path, title: note.title, excerpt: "", score: 0.5 });
    }
  }

  // 3. Scan fichiers pour ceux pas encore indexés (recherche contenu)
  const indexedPaths = new Set(notes.map((n) => n.path));
  const root = workspaceRoot(workspaceId);

  async function scanFiles(dir, rel) {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await scanFiles(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith(".md") && !indexedPaths.has(relPath)) {
        try {
          const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
          if (raw.toLowerCase().includes(q)) {
            const parsed = matter(raw);
            const body = parsed.content.toLowerCase();
            const idx = body.indexOf(q);
            const excerpt =
              idx >= 0
                ? parsed.content.slice(Math.max(0, idx - 60), idx + 120).trim()
                : "";
            results.push({
              path: relPath,
              title: extractTitle(relPath, parsed.data),
              excerpt,
              score: 0.4,
            });
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  await scanFiles(root, "");
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Graphe ──────────────────────────────────────────────────────

/**
 * Retourne les données du graphe de relations (nodes + edges).
 * @returns {{ nodes: {id, title, group}[], edges: {source, target}[] }}
 */
export async function getGraph(workspaceId) {
  const notes = await prisma.vaultNote.findMany({
    where: { workspaceId },
    select: { path: true, title: true, outlinks: true },
  });

  const nodes = notes.map((n) => ({
    id: n.path,
    title: n.title,
    group: n.path.split("/")[0] || "Root",
  }));

  const pathSet = new Set(notes.map((n) => n.path));
  const edges = [];
  for (const note of notes) {
    const outlinks = JSON.parse(note.outlinks || "[]");
    for (const target of outlinks) {
      if (pathSet.has(target)) {
        edges.push({ source: note.path, target });
      }
    }
  }

  return { nodes, edges };
}

/**
 * Retourne les notes qui pointent vers une note donnée (backlinks).
 */
export async function getBacklinks(workspaceId, notePath) {
  const notes = await prisma.vaultNote.findMany({
    where: {
      workspaceId,
      outlinks: { contains: notePath },
    },
    select: { path: true, title: true },
  });
  return notes;
}

// ─── Re-indexation complète ──────────────────────────────────────

/**
 * Scanne tout le vault filesystem et resynchronise les métadonnées en DB.
 * Utile après une migration ou un import manuel de fichiers.
 */
export async function reindexVault(workspaceId) {
  await ensureWorkspaceBaseStructure(workspaceId);
  const root = workspaceRoot(workspaceId);
  let count = 0;

  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
          await syncMetadata(workspaceId, relPath, raw);
          count++;
        } catch {
          /* ignore */
        }
      }
    }
  }

  await fs.mkdir(root, { recursive: true });
  await walk(root, "");
  return { reindexed: count };
}
