/**
 * projects.js — API REST pour les projets (Boatswain V1)
 *
 * GET    /api/projects              — Liste des projets du workspace
 * POST   /api/projects              — Créer un projet
 * GET    /api/projects/:id          — Détail projet (membres + documents)
 * PUT    /api/projects/:id          — Modifier le projet
 * DELETE /api/projects/:id          — Archiver le projet
 * POST   /api/projects/:id/members  — Ajouter un membre
 * DELETE /api/projects/:id/members/:userId — Retirer un membre
 * POST   /api/projects/:id/documents — Associer un document
 * DELETE /api/projects/:id/documents/:docId — Dissocier un document
 */

import { Router } from "express";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { writeNote, createFolder } from "../services/vault/vault-service.js";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────

function toSlug(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function generateUniqueSlug(workspaceId, baseName) {
  const base = toSlug(baseName);
  let slug = base;
  let attempt = 0;
  while (attempt < 10) {
    const existing = await prisma.project.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } }
    });
    if (!existing) return slug;
    attempt++;
    slug = `${base}-${attempt}`;
  }
  return `${base}-${Date.now()}`;
}

// ── Schemas ───────────────────────────────────────────────────────

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  status: z.enum(["active", "archived", "completed"]).optional().default("active")
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  status: z.enum(["active", "archived", "completed"]).optional()
});

const addMemberSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(["owner", "member", "viewer"]).optional().default("member")
});

const addDocumentSchema = z.object({
  title: z.string().min(1).max(500),
  vaultPath: z.string().max(500).optional(),
  knowledgeDocumentId: z.number().int().positive().optional()
});

const PROJECT_STATUSES = ["active", "archived", "completed"];

// ── GET /api/projects ─────────────────────────────────────────────

router.get("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    const userId = req.user.sub;
    const rawStatus = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    if (rawStatus && !PROJECT_STATUSES.includes(rawStatus)) {
      return res.status(400).json({
        error: "Invalid status",
        validValues: PROJECT_STATUSES,
      });
    }

    const status = rawStatus || undefined;

    const where = {
      ...(workspaceId ? { workspaceId } : {}),
      ...(status ? { status } : {}),
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {})
    };

    // Non-admins only see projects they are members of
    if (req.user.role !== "admin") {
      where.members = { some: { userId } };
    }

    const projects = await prisma.project.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { members: true, documents: true } },
        createdBy: { select: { id: true, email: true, companyName: true } },
        members: {
          where: { userId },
          select: { role: true }
        }
      }
    });

    return res.json({
      projects: projects.map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        status: p.status,
        vaultPath: p.vaultPath,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        createdBy: p.createdBy,
        memberCount: p._count.members,
        documentCount: p._count.documents,
        myRole: p.members[0]?.role || null
      }))
    });
  } catch (err) {
    console.error("[projects] GET / error:", {
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    });
    return res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// ── POST /api/projects ────────────────────────────────────────────

router.post("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  const parse = createProjectSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.issues[0]?.message || "Invalid request" });
  }

  try {
    const { name, description, status } = parse.data;
    const workspaceId = req.workspaceId;
    const userId = req.user.sub;

    const slug = await generateUniqueSlug(workspaceId, name);
    const vaultPath = `Projects/${slug}`;

    // Create project in DB
    const project = await prisma.project.create({
      data: {
        name,
        slug,
        description,
        status,
        vaultPath,
        workspaceId,
        createdById: userId,
        members: {
          create: { userId, role: "owner" }
        }
      },
      include: {
        _count: { select: { members: true, documents: true } },
        members: { where: { userId }, select: { role: true } }
      }
    });

    // Create vault structure (fire-and-forget)
    const indexNote = `---
projectId: "${project.id}"
name: "${name}"
slug: "${slug}"
status: "${status}"
createdAt: "${new Date().toISOString()}"
---

# ${name}

${description ? `> ${description}\n` : ""}

## Project Overview
_No content yet. Add documents and notes to get started._

## Documents
_No documents linked yet._

## Team
- Owner: ${req.user.email}
`;

    writeNote(workspaceId, `${vaultPath}/00-Index.md`, indexNote).catch(err =>
      console.warn("[projects] Failed to create vault index:", err.message)
    );
    createFolder(workspaceId, vaultPath, userId, {}).catch(() => {});

    logAudit(userId, "PROJECT_CREATE", { projectId: project.id, name, workspaceId });

    return res.status(201).json({
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        status: project.status,
        vaultPath: project.vaultPath,
        createdAt: project.createdAt,
        memberCount: project._count.members,
        documentCount: project._count.documents,
        myRole: "owner"
      }
    });
  } catch (err) {
    console.error("[projects] POST /:", err.message);
    return res.status(500).json({ error: "Failed to create project" });
  }
});

// ── GET /api/projects/:id ─────────────────────────────────────────

router.get("/:id", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const { id } = req.params;
    const workspaceId = req.workspaceId;
    const userId = req.user.sub;

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        members: {
          include: { user: { select: { id: true, email: true, companyName: true } } }
        },
        documents: {
          include: { knowledgeDoc: { select: { id: true, title: true, docType: true } } }
        },
        createdBy: { select: { id: true, email: true, companyName: true } }
      }
    });

    if (!project || project.workspaceId !== workspaceId) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Non-admins must be members
    if (req.user.role !== "admin") {
      const isMember = project.members.some(m => m.userId === userId);
      if (!isMember) return res.status(403).json({ error: "Access denied" });
    }

    return res.json({ project });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch project" });
  }
});

// ── PUT /api/projects/:id ─────────────────────────────────────────

router.put("/:id", requireAuth, requireWorkspaceContext, async (req, res) => {
  const parse = updateProjectSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.issues[0]?.message || "Invalid request" });
  }

  try {
    const { id } = req.params;
    const workspaceId = req.workspaceId;
    const userId = req.user.sub;

    const project = await prisma.project.findUnique({
      where: { id },
      include: { members: { where: { userId } } }
    });

    if (!project || project.workspaceId !== workspaceId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const myRole = project.members[0]?.role;
    if (req.user.role !== "admin" && myRole !== "owner") {
      return res.status(403).json({ error: "Only owners can edit projects" });
    }

    const updated = await prisma.project.update({
      where: { id },
      data: parse.data
    });

    logAudit(userId, "PROJECT_UPDATE", { projectId: id, changes: parse.data });

    return res.json({ project: updated });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update project" });
  }
});

// ── DELETE /api/projects/:id ──────────────────────────────────────

router.delete("/:id", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const { id } = req.params;
    const workspaceId = req.workspaceId;
    const userId = req.user.sub;

    const project = await prisma.project.findUnique({
      where: { id },
      include: { members: { where: { userId } } }
    });

    if (!project || project.workspaceId !== workspaceId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const myRole = project.members[0]?.role;
    if (req.user.role !== "admin" && myRole !== "owner") {
      return res.status(403).json({ error: "Only owners can delete projects" });
    }

    // Soft delete — archive instead of destroy
    await prisma.project.update({
      where: { id },
      data: { status: "archived" }
    });

    logAudit(userId, "PROJECT_ARCHIVE", { projectId: id });

    return res.json({ success: true, message: "Project archived" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to archive project" });
  }
});

// ── POST /api/projects/:id/members ────────────────────────────────

router.post("/:id/members", requireAuth, requireWorkspaceContext, async (req, res) => {
  const parse = addMemberSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "userId (number) and optional role required" });
  }

  try {
    const { id } = req.params;
    const workspaceId = req.workspaceId;
    const requesterId = req.user.sub;
    const { userId: targetUserId, role } = parse.data;

    const project = await prisma.project.findUnique({
      where: { id },
      include: { members: { where: { userId: requesterId } } }
    });

    if (!project || project.workspaceId !== workspaceId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const myRole = project.members[0]?.role;
    if (req.user.role !== "admin" && myRole !== "owner") {
      return res.status(403).json({ error: "Only owners can add members" });
    }

    const member = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: id, userId: targetUserId } },
      create: { projectId: id, userId: targetUserId, role },
      update: { role }
    });

    return res.status(201).json({ member });
  } catch (err) {
    return res.status(500).json({ error: "Failed to add member" });
  }
});

// ── DELETE /api/projects/:id/members/:userId ──────────────────────

router.delete("/:id/members/:memberId", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const { id, memberId } = req.params;
    const workspaceId = req.workspaceId;
    const requesterId = req.user.sub;
    const targetUserId = Number(memberId);

    const project = await prisma.project.findUnique({
      where: { id },
      include: { members: { where: { userId: requesterId } } }
    });

    if (!project || project.workspaceId !== workspaceId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const myRole = project.members[0]?.role;
    const isSelf = requesterId === targetUserId;

    if (req.user.role !== "admin" && myRole !== "owner" && !isSelf) {
      return res.status(403).json({ error: "Cannot remove this member" });
    }

    await prisma.projectMember.deleteMany({
      where: { projectId: id, userId: targetUserId }
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to remove member" });
  }
});

// ── POST /api/projects/:id/documents ─────────────────────────────

router.post("/:id/documents", requireAuth, requireWorkspaceContext, async (req, res) => {
  const parse = addDocumentSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.issues[0]?.message || "Invalid request" });
  }

  try {
    const { id } = req.params;
    const workspaceId = req.workspaceId;
    const userId = req.user.sub;

    const project = await prisma.project.findUnique({
      where: { id },
      include: { members: { where: { userId } } }
    });

    if (!project || project.workspaceId !== workspaceId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const myRole = project.members[0]?.role;
    if (req.user.role !== "admin" && myRole === "viewer") {
      return res.status(403).json({ error: "Viewers cannot add documents" });
    }

    const doc = await prisma.projectDocument.create({
      data: {
        projectId: id,
        title: parse.data.title,
        vaultPath: parse.data.vaultPath || null,
        knowledgeDocumentId: parse.data.knowledgeDocumentId || null
      }
    });

    return res.status(201).json({ document: doc });
  } catch (err) {
    return res.status(500).json({ error: "Failed to add document" });
  }
});

// ── DELETE /api/projects/:id/documents/:docId ─────────────────────

router.delete("/:id/documents/:docId", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const { id, docId } = req.params;
    const workspaceId = req.workspaceId;
    const userId = req.user.sub;

    const project = await prisma.project.findUnique({
      where: { id },
      include: { members: { where: { userId } } }
    });

    if (!project || project.workspaceId !== workspaceId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const myRole = project.members[0]?.role;
    if (req.user.role !== "admin" && myRole === "viewer") {
      return res.status(403).json({ error: "Viewers cannot remove documents" });
    }

    await prisma.projectDocument.deleteMany({
      where: { id: docId, projectId: id }
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to remove document" });
  }
});

export default router;
