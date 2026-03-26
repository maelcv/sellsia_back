/**
 * routes/custom-fields.js
 *
 * Phase 5: Custom fields management
 * Feature flag: custom_fields
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { requireFeature } from "../middleware/auth.js";
import { prisma } from "../prisma.js";

const router = Router();
router.use(requireAuth, requireWorkspaceContext, requireFeature("custom_fields"));

const fieldSchema = z.object({
  entityType: z.enum(["company", "contact", "opportunity", "user"]),
  fieldName: z.string().regex(/^[a-z_]+$/),
  fieldLabel: z.string().min(1),
  fieldType: z.enum(["text", "number", "date", "select", "boolean"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().default(false),
});

// POST /api/custom-fields
router.post("/", async (req, res) => {
  const body = fieldSchema.parse(req.body);

  const def = await prisma.customFieldDefinition.create({
    data: {
      workspaceId: req.workspaceId,
      entityType: body.entityType,
      fieldName: body.fieldName,
      fieldLabel: body.fieldLabel,
      fieldType: body.fieldType,
      options: body.options ? JSON.stringify(body.options) : null,
      required: body.required,
    },
  });

  res.status(201).json(def);
});

// GET /api/custom-fields/:entityType
router.get("/:entityType", async (req, res) => {
  const defs = await prisma.customFieldDefinition.findMany({
    where: {
      workspaceId: req.workspaceId,
      entityType: req.params.entityType,
    },
    orderBy: { sortOrder: "asc" },
  });
  res.json({ fields: defs });
});

// PUT /api/custom-fields/:id
router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = fieldSchema.partial().parse(req.body);

  const def = await prisma.customFieldDefinition.update({
    where: { id },
    data: body,
  });

  res.json(def);
});

// DELETE /api/custom-fields/:id
router.delete("/:id", async (req, res) => {
  await prisma.customFieldDefinition.deleteMany({ where: { id: parseInt(req.params.id, 10) } });
  res.json({ success: true });
});

// POST /api/custom-fields/values
router.post("/values", async (req, res) => {
  const { definitionId, entityType, entityId, value } = z.object({
    definitionId: z.number(),
    entityType: z.string(),
    entityId: z.string(),
    value: z.string(),
  }).parse(req.body);

  const fieldValue = await prisma.customFieldValue.upsert({
    where: { definitionId_entityId: { definitionId, entityId } },
    create: { definitionId, entityType, entityId, value },
    update: { value },
  });

  res.json(fieldValue);
});

export default router;
