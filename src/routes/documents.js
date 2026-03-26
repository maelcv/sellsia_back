/**
 * routes/documents.js
 *
 * Phase 4: Document management + OCR
 * Feature flag: documents
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { requireFeature } from "../middleware/auth.js";
import { prisma } from "../prisma.js";

const router = Router();
router.use(requireAuth, requireWorkspaceContext, requireFeature("documents"));

// POST /api/documents/upload
router.post("/upload", async (req, res) => {
  const { title, fileName, fileUrl, mimeType, fileSize, entityType, entityId } = z.object({
    title: z.string().min(1),
    fileName: z.string(),
    fileUrl: z.string().url(),
    mimeType: z.string(),
    fileSize: z.number(),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
  }).parse(req.body);

  const doc = await prisma.document.create({
    data: {
      userId: req.user.sub,
      workspaceId: req.workspaceId,
      title, fileName, fileUrl, mimeType, fileSize,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      ocrStatus: "pending",
    },
  });

  // TODO: trigger OCR worker
  res.status(201).json(doc);
});

// GET /api/documents
router.get("/", async (req, res) => {
  const docs = await prisma.document.findMany({
    where: { userId: req.user.sub },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ documents: docs });
});

// GET /api/documents/:id
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const doc = await prisma.document.findFirst({
    where: { id, userId: req.user.sub },
  });
  if (!doc) return res.status(404).json({ error: "Document not found" });
  res.json(doc);
});

// DELETE /api/documents/:id
router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await prisma.document.deleteMany({ where: { id, userId: req.user.sub } });
  res.json({ success: true });
});

export default router;
