/**
 * routes/admin-system-email.js
 *
 * Lecture et mise à jour de la configuration SMTP système (scope plateforme).
 * Réservé aux admins. Source de vérité : systemSetting key="system_smtp_config".
 * Fallback lecture-seule sur les variables d'env si aucune entrée DB.
 */

import { Router } from "express";
import { z } from "zod";
import nodemailer from "nodemailer";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../prisma.js";
import { encryptSecret, decryptSecret } from "../security/secrets.js";

const router = Router();

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

router.use(requireAuth, requireAdmin);

const SETTING_KEY = "system_smtp_config";

// ── Charge la config depuis DB ou env ────────────────────────────
function loadFromEnv() {
  return {
    source: "env",
    smtpHost:    process.env.SMTP_HOST    || "",
    smtpPort:    parseInt(process.env.SMTP_PORT || "587", 10),
    smtpUser:    process.env.SMTP_USER    || "",
    smtpSecure:  process.env.SMTP_SECURE === "true" || process.env.SMTP_PORT === "465",
    fromEmail:   process.env.SMTP_FROM_EMAIL || process.env.SMTP_FROM || "",
    fromName:    process.env.SMTP_FROM_NAME  || "",
    hasPassword: !!(process.env.SMTP_PASS),
  };
}

async function loadConfig() {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return loadFromEnv();

  const raw = JSON.parse(row.value);
  return {
    source:      "db",
    smtpHost:    raw.host,
    smtpPort:    raw.port,
    smtpUser:    raw.user,
    smtpSecure:  raw.secure,
    fromEmail:   raw.fromEmail || "",
    fromName:    raw.fromName  || "",
    hasPassword: !!(raw.passEncrypted),
  };
}

// ── GET /api/admin/system-email ───────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json({ config: cfg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/admin/system-email ───────────────────────────────────
const updateSchema = z.object({
  smtpHost:   z.string().min(1),
  smtpPort:   z.number().int().min(1).max(65535),
  smtpUser:   z.string().min(1),
  smtpPass:   z.string().optional(),   // absent = ne pas changer
  smtpSecure: z.boolean(),
  fromEmail:  z.string().email(),
  fromName:   z.string().optional(),
});

router.put("/", async (req, res) => {
  try {
    const body = updateSchema.parse(req.body);

    // Charger la config existante pour conserver le mot de passe si non fourni
    const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
    const existing = row?.value ? JSON.parse(row.value) : null;

    let passEncrypted = existing?.passEncrypted ?? null;
    if (body.smtpPass) {
      passEncrypted = encryptSecret(body.smtpPass);
    }

    if (!passEncrypted) {
      // Fallback : essayer env
      if (process.env.SMTP_PASS) {
        passEncrypted = encryptSecret(process.env.SMTP_PASS);
      } else {
        return res.status(400).json({ error: "Mot de passe SMTP requis (aucun mot de passe existant)" });
      }
    }

    const value = JSON.stringify({
      host:         body.smtpHost,
      port:         body.smtpPort,
      user:         body.smtpUser,
      passEncrypted,
      secure:       body.smtpSecure,
      fromEmail:    body.fromEmail,
      fromName:     body.fromName || null,
    });

    await prisma.systemSetting.upsert({
      where:  { key: SETTING_KEY },
      update: { value, updatedAt: new Date() },
      create: { key: SETTING_KEY, value },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/admin/system-email/test ────────────────────────────
router.post("/test", async (req, res) => {
  try {
    const { to } = z.object({ to: z.string().email() }).parse(req.body);

    const cfg = await loadConfig();

    // Résoudre le mot de passe
    let pass;
    const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
    if (row?.value) {
      const raw = JSON.parse(row.value);
      pass = raw.passEncrypted ? decryptSecret(raw.passEncrypted) : null;
    } else {
      pass = process.env.SMTP_PASS || null;
    }

    const transporter = nodemailer.createTransport({
      host:   cfg.smtpHost,
      port:   cfg.smtpPort,
      secure: cfg.smtpSecure,
      auth:   cfg.smtpUser ? { user: cfg.smtpUser, pass } : undefined,
      connectionTimeout: 10000,
    });

    await transporter.verify();

    await transporter.sendMail({
      from:    cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail,
      to,
      subject: "Test SMTP — Boatswain Platform",
      html:    "<p>La configuration SMTP système fonctionne correctement ✅</p>",
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
