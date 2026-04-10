/**
 * Knowledge Base Routes -- CRUD pour les documents de la base de connaissances.
 *
 * GET    /api/knowledge              -- Lister les documents
 * POST   /api/knowledge              -- Ajouter un document
 * PUT    /api/knowledge/:id          -- Modifier un document
 * DELETE /api/knowledge/:id          -- Supprimer un document
 */

import express from "express";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";

const router = express.Router();

const docSchema = z.object({
  title: z.string().min(2).max(200),
  content: z.string().min(10).max(50000),
  docType: z.enum(["text", "faq", "process", "config", "api_doc"]).optional().default("text"),
  agentId: z.string().max(64).optional(),
  clientId: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.any()).optional().default({})
});

// -- GET /api/knowledge -- Lister les documents --

router.get("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const userId = req.user.sub;

  try {
    let docs;
    if (isAdmin) {
      docs = await prisma.knowledgeDocument.findMany({
        include: {
          agent: { select: { name: true } },
          client: { select: { email: true } }
        },
        orderBy: { updatedAt: "desc" }
      });
    } else {
      docs = await prisma.knowledgeDocument.findMany({
        where: {
          OR: [
            { clientId: null },
            { clientId: userId }
          ]
        },
        include: {
          agent: { select: { name: true } }
        },
        orderBy: { updatedAt: "desc" }
      });
    }

    return res.json({
      documents: docs.map((d) => {
        let metadata = {};
        try { metadata = d.metadataJson ? JSON.parse(d.metadataJson) : {}; } catch {}
        return {
          id: d.id,
          title: d.title,
          content: d.content,
          docType: d.docType,
          agentId: d.agentId,
          clientId: d.clientId || undefined,
          isActive: d.isActive,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          agentName: d.agent?.name || null,
          clientEmail: isAdmin ? (d.client?.email || null) : undefined,
          metadata
        };
      })
    });
  } catch (err) {
    return res.status(500).json({ error: "Erreur lors de la récupération des documents" });
  }
});

// -- POST /api/knowledge -- Ajouter un document --

router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = docSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid document payload" });
  }

  const { title, content, docType, agentId, clientId, metadata } = parse.data;

  try {
    await prisma.knowledgeDocument.create({
      data: {
        title,
        content,
        docType,
        agentId: agentId || null,
        clientId: clientId || null,
        metadataJson: JSON.stringify(metadata)
      }
    });
  } catch (err) {
    return res.status(500).json({ error: "Erreur lors de la création du document" });
  }

  await logAudit(req.user.sub, "KNOWLEDGE_DOC_CREATED", { title, docType });
  return res.status(201).json({ message: "Document created" });
});

// -- PUT /api/knowledge/:id -- Modifier un document --

router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid document id" });
  }

  const parse = docSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid document payload" });
  }

  const { title, content, docType, agentId, clientId, metadata } = parse.data;

  try {
    await prisma.knowledgeDocument.update({
      where: { id },
      data: {
        title,
        content,
        docType,
        agentId: agentId || null,
        clientId: clientId || null,
        metadataJson: JSON.stringify(metadata),
        updatedAt: new Date()
      }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Document not found" });
    }
    throw err;
  }

  await logAudit(req.user.sub, "KNOWLEDGE_DOC_UPDATED", { docId: id });
  return res.json({ message: "Document updated" });
});

// -- DELETE /api/knowledge/:id -- Supprimer un document --

router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid document id" });
  }

  try {
    await prisma.knowledgeDocument.delete({
      where: { id }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Document not found" });
    }
    throw err;
  }

  await logAudit(req.user.sub, "KNOWLEDGE_DOC_DELETED", { docId: id });
  return res.json({ message: "Document deleted" });
});

export default router;
