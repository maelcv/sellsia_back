/**
 * Vault Share Service — Public document sharing within a workspace.
 *
 * When a user shares a note, this service:
 *  1. Reads the source note content
 *  2. Calls an AI provider to determine the best Public/ subfolder
 *  3. Copies the note to Public/<category>/<filename>
 *  4. Persists the share record in vault_shares (DB)
 *
 * The original note is never moved. The public copy is independent.
 * Unsharing deletes the copy and removes the DB record.
 */

import path from "path";
import fs from "fs/promises";
import { prisma } from "../../prisma.js";
import { readNote, writeNote, deleteNote } from "./vault-service.js";
import { getProviderForUser } from "../../ai-providers/index.js";

const PUBLIC_FOLDER = "Public";

// ── Helpers ──────────────────────────────────────────────────────────

function extractFilename(notePath) {
  return path.basename(notePath);
}

/**
 * Ask an AI to determine the best subfolder inside Public/ for this content.
 * Returns a sanitized folder name like "Contracts" or "Marketing".
 */
async function classifyPublicFolder(provider, noteContent, filename) {
  const excerpt = (noteContent || "").slice(0, 3000);
  const prompt = `You are a document organizer. Given this document, determine the best single-level subfolder name inside a "Public" workspace folder.

Filename: ${filename}
Content excerpt:
---
${excerpt}
---

Rules:
- Reply with ONLY a JSON object: { "folder": "FolderName" }
- The folder name must be a short English noun or phrase (2-30 chars), title case, no special characters
- Choose the most relevant category: e.g. "Contracts", "Reports", "Marketing", "Technical", "Finance", "Legal", "HR", "General"
- If unsure, use "General"`;

  try {
    const result = await provider.chat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      maxTokens: 60,
    });
    const raw = result?.content || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return "General";
    const parsed = JSON.parse(match[0]);
    const folder = String(parsed.folder || "General").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
    return folder || "General";
  } catch {
    return "General";
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Share a vault note publicly within the workspace.
 * Copies the note to Public/<AI-category>/<filename> and persists the share record.
 *
 * @param {object} params
 * @param {string} params.workspaceId
 * @param {string} params.sourcePath  - Original path (e.g. "42/Uploads/2026-04/contract.md")
 * @param {number} params.userId      - ID of the user performing the share
 * @returns {Promise<{ publicPath: string }>}
 */
export async function shareNotePublic({ workspaceId, sourcePath, userId }) {
  // 1. Read source note
  const note = await readNote(workspaceId, sourcePath);
  if (!note) {
    throw new Error(`Note not found: ${sourcePath}`);
  }

  // 2. Determine public folder via AI (best-effort, fallback to "General")
  let category = "General";
  try {
    const provider = await getProviderForUser(userId);
    if (provider) {
      category = await classifyPublicFolder(provider, note.content || note.body || "", extractFilename(sourcePath));
    }
  } catch {
    // Non-blocking — use default category
  }

  // 3. Build public path: Public/<category>/<filename>
  const filename = extractFilename(sourcePath);
  const publicPath = `${PUBLIC_FOLDER}/${category}/${filename}`;

  // 4. Copy note content to public path
  await writeNote(workspaceId, publicPath, note.content || note.body || "");

  // 5. Persist share record (upsert on sourcePath)
  await prisma.vaultShare.upsert({
    where: { workspaceId_sourcePath: { workspaceId, sourcePath } },
    create: { workspaceId, sourcePath, publicPath, sharedById: userId },
    update: { publicPath, sharedById: userId },
  });

  return { publicPath };
}

/**
 * Remove a public share — deletes the public copy and the DB record.
 *
 * @param {object} params
 * @param {string} params.workspaceId
 * @param {string} params.sourcePath
 * @param {number} params.userId      - Must be the original sharer or an admin
 */
export async function unshareNote({ workspaceId, sourcePath, userId, userRole }) {
  const share = await prisma.vaultShare.findUnique({
    where: { workspaceId_sourcePath: { workspaceId, sourcePath } },
  });

  if (!share) return; // Already unshared — idempotent

  const isAdmin = userRole === "ADMIN" || userRole === "GESTIONNAIRE";
  if (!isAdmin && share.sharedById !== userId) {
    throw new Error("You can only unshare your own documents");
  }

  // Delete the public copy from filesystem (best-effort)
  try {
    await deleteNote(workspaceId, share.publicPath);
  } catch {
    // If copy doesn't exist, continue with DB cleanup
  }

  await prisma.vaultShare.delete({
    where: { workspaceId_sourcePath: { workspaceId, sourcePath } },
  });
}

/**
 * List all shares for a workspace (admin) or for a specific user.
 *
 * @param {object} params
 * @param {string} params.workspaceId
 * @param {number|null} params.userId  - null = all shares (admin only)
 */
export async function listShares({ workspaceId, userId = null }) {
  const where = userId
    ? { workspaceId, sharedById: userId }
    : { workspaceId };

  return prisma.vaultShare.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { sharedBy: { select: { id: true, email: true } } },
  });
}
