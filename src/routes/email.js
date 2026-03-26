/**
 * routes/email.js
 *
 * Gestion de la configuration SMTP personnelle et envoi d'emails.
 * Feature flag : email_service
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { requireFeature } from "../middleware/auth.js";
import { prisma } from "../prisma.js";
import { encryptSmtpPassword, decryptSmtpPassword, sendEmail } from "../../ia_models/email/email-service.js";

const router = Router();
router.use(requireAuth, requireWorkspaceContext, requireFeature("email_service"));

// ── Schémas ──────────────────────────────────────────────────

const configSchema = z.object({
  smtpHost:    z.string().min(1),
  smtpPort:    z.number().int().min(1).max(65535).default(587),
  smtpUser:    z.string().min(1),
  smtpPass:    z.string().min(1).optional(), // optionnel en update (ne pas écraser si absent)
  smtpSecure:  z.boolean().default(false),
  imapHost:    z.string().optional(),
  imapPort:    z.number().int().optional(),
  fromName:    z.string().optional(),
  fromEmail:   z.string().email(),
  rgpdConsent: z.boolean(),
});

const sendSchema = z.object({
  to:      z.union([z.string().email(), z.array(z.string().email())]),
  cc:      z.union([z.string(), z.array(z.string())]).optional(),
  bcc:     z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().min(1),
  text:    z.string().optional(),
  html:    z.string().optional(),
});

// ── GET /api/email/config ─────────────────────────────────────
router.get("/config", async (req, res) => {
  const config = await prisma.emailConfig.findUnique({
    where: { userId: req.user.sub },
    select: {
      id: true, smtpHost: true, smtpPort: true, smtpUser: true,
      smtpSecure: true, imapHost: true, imapPort: true,
      fromName: true, fromEmail: true, rgpdConsent: true,
      rgpdConsentAt: true, isActive: true, createdAt: true, updatedAt: true,
      // Ne jamais retourner smtpPassEncrypted
    },
  });
  res.json({ config });
});

// ── POST /api/email/config ────────────────────────────────────
router.post("/config", async (req, res) => {
  const body = configSchema.parse(req.body);

  if (!body.smtpPass) {
    return res.status(400).json({ error: "smtpPass requis à la création" });
  }

  const existing = await prisma.emailConfig.findUnique({ where: { userId: req.user.sub } });
  if (existing) {
    return res.status(409).json({ error: "Config email déjà existante, utilisez PUT pour la modifier" });
  }

  const config = await prisma.emailConfig.create({
    data: {
      userId:           req.user.sub,
      workspaceId:      req.workspaceId,
      smtpHost:         body.smtpHost,
      smtpPort:         body.smtpPort,
      smtpUser:         body.smtpUser,
      smtpPassEncrypted: encryptSmtpPassword(body.smtpPass),
      smtpSecure:       body.smtpSecure,
      imapHost:         body.imapHost ?? null,
      imapPort:         body.imapPort ?? null,
      fromName:         body.fromName ?? null,
      fromEmail:        body.fromEmail,
      rgpdConsent:      body.rgpdConsent,
      rgpdConsentAt:    body.rgpdConsent ? new Date() : null,
    },
  });

  res.status(201).json({ config: { id: config.id } });
});

// ── PUT /api/email/config ─────────────────────────────────────
router.put("/config", async (req, res) => {
  const body = configSchema.partial().parse(req.body);

  const existing = await prisma.emailConfig.findUnique({ where: { userId: req.user.sub } });
  if (!existing) {
    return res.status(404).json({ error: "Aucune config email — utilisez POST pour créer" });
  }

  const updateData = {
    ...(body.smtpHost    !== undefined && { smtpHost: body.smtpHost }),
    ...(body.smtpPort    !== undefined && { smtpPort: body.smtpPort }),
    ...(body.smtpUser    !== undefined && { smtpUser: body.smtpUser }),
    ...(body.smtpPass    !== undefined && { smtpPassEncrypted: encryptSmtpPassword(body.smtpPass) }),
    ...(body.smtpSecure  !== undefined && { smtpSecure: body.smtpSecure }),
    ...(body.imapHost    !== undefined && { imapHost: body.imapHost }),
    ...(body.imapPort    !== undefined && { imapPort: body.imapPort }),
    ...(body.fromName    !== undefined && { fromName: body.fromName }),
    ...(body.fromEmail   !== undefined && { fromEmail: body.fromEmail }),
    ...(body.rgpdConsent !== undefined && {
      rgpdConsent: body.rgpdConsent,
      rgpdConsentAt: body.rgpdConsent && !existing.rgpdConsentAt ? new Date() : existing.rgpdConsentAt,
    }),
  };

  await prisma.emailConfig.update({ where: { userId: req.user.sub }, data: updateData });
  res.json({ success: true });
});

// ── DELETE /api/email/config ──────────────────────────────────
router.delete("/config", async (req, res) => {
  await prisma.emailConfig.deleteMany({ where: { userId: req.user.sub } });
  res.json({ success: true });
});

// ── POST /api/email/test ──────────────────────────────────────
router.post("/test", async (req, res) => {
  const { to } = z.object({ to: z.string().email() }).parse(req.body);

  await sendEmail({
    userId:   req.user.sub,
    tenantId: req.workspaceId,
    to,
    subject:  "Test de connexion Sellsia",
    html:     "<p>Si vous recevez cet email, votre configuration SMTP fonctionne ✅</p>",
  });

  res.json({ success: true });
});

// ── POST /api/email/send ──────────────────────────────────────
router.post("/send", async (req, res) => {
  const body = sendSchema.parse(req.body);

  await sendEmail({
    userId:   req.user.sub,
    tenantId: req.workspaceId,
    ...body,
  });

  res.json({ success: true });
});

// ── GET /api/email/logs ───────────────────────────────────────
router.get("/logs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const logs = await prisma.emailLog.findMany({
    where: { userId: req.user.sub },
    orderBy: { sentAt: "desc" },
    take: limit,
  });
  res.json({ logs });
});

export default router;
