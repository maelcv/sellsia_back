import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
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

  const { authenticator } = await import("otplib");
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.email, "Sellsia", secret);

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

  const { authenticator } = await import("otplib");
  const isValid = authenticator.check(parsed.data.code, user.twoFactorSecret);
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
  if (req.user.role !== "admin") {
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

export default router;
