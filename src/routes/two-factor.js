import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import { generateSecret, generateURI, verifySync } from "otplib";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();


router.use(requireAuth);

// ─── POST /api/2fa/setup — Générer un secret + QR code ─────

router.post("/setup", async (req, res) => {
  const userId = req.user.sub;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, twoFactorEnabled: true },
  });

  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: "2FA déjà activé" });
  }

  const secret = generateSecret();
  const otpauth = generateURI({ label: user.email, issuer: "Boatswain", secret });

  // Stocker le secret temporairement (pas encore enabled)
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: secret },
  });

  const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

  return res.json({
    secret,
    qrCode: qrCodeDataUrl,
    otpauth,
  });
});

// ─── POST /api/2fa/verify — Vérifier un code et activer 2FA ─

const verifySchema = z.object({
  code: z.string().length(6),
});

router.post("/verify", async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Code invalide (6 chiffres requis)" });
  }

  const userId = req.user.sub;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorSecret: true, twoFactorEnabled: true },
  });

  if (!user || !user.twoFactorSecret) {
    return res.status(400).json({ error: "Lancez d'abord /api/2fa/setup" });
  }
  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: "2FA déjà activé" });
  }

  const isValid = verifySync({ secret: user.twoFactorSecret, token: parsed.data.code }).valid;
  if (!isValid) {
    return res.status(401).json({ error: "Code TOTP invalide" });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: true },
  });

  return res.json({ success: true, message: "2FA activé avec succès" });
});

// ─── POST /api/2fa/disable — Désactiver 2FA (avec mot de passe) ─

const disableSchema = z.object({
  password: z.string().min(1),
});

router.post("/disable", async (req, res) => {
  const parsed = disableSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Mot de passe requis" });
  }

  const userId = req.user.sub;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, twoFactorEnabled: true },
  });

  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  if (!user.twoFactorEnabled) {
    return res.status(400).json({ error: "2FA n'est pas activé" });
  }

  const isValidPassword = bcrypt.compareSync(parsed.data.password, user.passwordHash);
  if (!isValidPassword) {
    return res.status(401).json({ error: "Mot de passe incorrect" });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: null, twoFactorEnabled: false },
  });

  return res.json({ success: true, message: "2FA désactivé" });
});

/**
 * POST /api/2fa/admin-disable
 * Désactiver 2FA d'un utilisateur (admin seulement)
 */
router.post("/admin-disable", async (req, res) => {
  // Only admins can use this
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ error: "Interdit. Admin seulement." });
  }

  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "userId requis" });
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { id: true, email: true }
  });

  if (!targetUser) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  await prisma.user.update({
    where: { id: targetUser.id },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null
    }
  });

  return res.json({
    success: true,
    message: `2FA désactivé pour ${targetUser.email}`
  });
});

// ─── POST /api/2fa/request-email-code ─────────────────────
router.post("/request-email-code", async (req, res) => {
  const userId = req.user.sub;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, id: true, workspaceId: true },
  });

  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorCode: code,
      twoFactorCodeExpires: expires,
    },
  });

  try {
    const { renderEmailTemplate, sendEmail } = await import("../services/email/email-service.js");
    const html = renderEmailTemplate({
      title: "Votre code de sécurité",
      content: `
        <p>Vous avez demandé une modification de vos paramètres de sécurité (2FA).</p>
        <p>Veuillez utiliser le code de vérification suivant :</p>
        <div class="verification-code">${code}</div>
        <p>Ce code est valable pendant 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
      `,
    });

    await sendEmail({
      userId: user.id,
      workspaceId: user.workspaceId,
      to: user.email,
      subject: `[Boatswain] Votre code de vérification : ${code}`,
      html,
    });

    return res.json({ success: true, message: "Code envoyé par email" });
  } catch (err) {
    console.error("[2FA] Email failed:", err);
    return res.status(500).json({ error: `Échec de l'envoi de l'email: ${err.message}` });
  }
});

// ─── POST /api/2fa/confirm-email-code ─────────────────────
const confirmEmailCodeSchema = z.object({
  code: z.string().length(6),
  action: z.enum(["enable", "disable"]),
});

router.post("/confirm-email-code", async (req, res) => {
  const parsed = confirmEmailCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Données invalides" });
  }

  const userId = req.user.sub;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorCode: true, twoFactorCodeExpires: true, twoFactorEnabled: true },
  });

  if (!user || user.twoFactorCode !== parsed.data.code) {
    return res.status(401).json({ error: "Code incorrect" });
  }

  if (user.twoFactorCodeExpires < new Date()) {
    return res.status(401).json({ error: "Code expiré" });
  }

  // Clear code
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorCode: null, twoFactorCodeExpires: null },
  });

  if (parsed.data.action === "disable") {
    await prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
    return res.json({ success: true, message: "2FA désactivé" });
  } else {
    // Action 'enable' doesn't enable yet, but grants permission to see the QR code
    // In our simplified flow, we'll return a success status
    return res.json({ success: true, message: "Email vérifié" });
  }
});

export default router;
