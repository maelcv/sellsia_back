import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { randomBytes } from "crypto";
import { TOTP } from "otplib";
import { prisma, hasAnyUsers, logAudit } from "../prisma.js";
import { config } from "../config.js";
import { authRateLimit } from "../middleware/security.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { encryptSecret, maskSecret } from "../security/secrets.js";
import { sendEmail } from "../services/email/email-service.js";

const router = express.Router();
const totp = new TOTP();

// ── 2FA Email Codes (In-Memory Storage) ────────────────────────
// Map: userId -> { code, expiresAt, email }
const twoFactorCodes = new Map();

// Cleanup expired codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of twoFactorCodes.entries()) {
    if (data.expiresAt < now) {
      twoFactorCodes.delete(userId);
    }
  }
}, 5 * 60 * 1000);

/**
 * Generate a unique workspace slug, retrying with numeric suffix if collision detected.
 */
async function generateUniqueSlug(baseName) {
  const baseSlug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);

  // Try the base slug first
  let slug = baseSlug;
  for (let i = 1; i <= 10; i++) {
    const existing = await prisma.workspace.findUnique({
      where: { slug },
      select: { id: true }
    });
    if (!existing) return slug;
    // Add numeric suffix and retry
    slug = `${baseSlug.substring(0, 45)}-${i}`;
  }

  // Fallback: use uuid suffix (should never reach here in practice)
  throw new Error("Unable to generate unique workspace slug after 10 retries");
}

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128)
});

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  companyName: z.string().min(1).max(200)
});

const onboardSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  companyName: z.string().min(1).max(200).optional(),
  services: z.array(z.object({
    code: z.string(),
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    config: z.record(z.any()).optional()
  })).optional()
});

router.get("/bootstrap-status", async (_req, res) => {
  try {
    const hasUsers = await hasAnyUsers();
    let setupComplete = false;
    try {
      const setupSetting = await prisma.systemSetting.findUnique({ where: { key: "setup_completed" } });
      setupComplete = setupSetting?.value === "true";
    } catch (err) {
      // Skip if RLS policies prevent access
      if (!err?.message?.includes("Tenant or user not found") && !err?.message?.includes("FATAL")) {
        throw err;
      }
    }

    return res.json({
      hasUsers,
      setupComplete,
      needsOnboarding: !hasUsers || !setupComplete
    });
  } catch (err) {
    console.error("[auth] bootstrap-status error:", err.message);
    return res.json({
      hasUsers: false,
      setupComplete: false,
      needsOnboarding: true
    });
  }
});

router.post("/onboard", authRateLimit, async (req, res) => {
  const has = await hasAnyUsers();
  if (has) {
    return res.status(403).json({ error: "Platform already initialized" });
  }

  const parse = onboardSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { email, password, companyName, services } = parse.data;
  const passwordHash = bcrypt.hashSync(password, 12);

  // Create workspace for the new user (with unique slug handling)
  const workspaceName = companyName || email.split("@")[0];
  const slug = await generateUniqueSlug(workspaceName);
  const workspace = await prisma.workspace.create({
    data: {
      name: workspaceName,
      slug,
      status: "active"
    }
  });

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash,
      role: "admin",
      companyName: companyName || null,
      workspaceId: workspace.id // Associate user with workspace immediately
    }
  });

  // ─── Post-onboarding: Save services if provided ───
  if (services && services.length > 0) {
    for (const s of services) {
      // Find the service definition
      const serviceDef = await prisma.externalService.findUnique({ where: { code: s.code } });
      if (!serviceDef) continue;

      await prisma.clientServiceLink.create({
        data: {
          ownerUserId: user.id,
          serviceId: serviceDef.id,
          label: serviceDef.name,
          apiKeyEncrypted: s.apiKey ? encryptSecret(s.apiKey) : null,
          apiSecretEncrypted: s.apiSecret ? encryptSecret(s.apiSecret) : null,
          apiKeyMasked: s.apiKey ? maskSecret(s.apiKey) : "",
          apiSecretMasked: s.apiSecret ? maskSecret(s.apiSecret) : "",
          status: "active",
          configJson: JSON.stringify(s.config || {})
        }
      });
    }
  }

  await logAudit(user.id, "onboard", { email: email.toLowerCase(), servicesCount: services?.length || 0 });

  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, companyName: user.companyName },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, companyName: user.companyName, whatsappPhone: user.whatsappPhone }
  });
});

// DUMMY_HASH for timing attack prevention
const DUMMY_HASH = "$2a$12$invalidhashfortimingXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

// ─── POST /signup — Client signup with automatic workspace creation ────
router.post("/signup", authRateLimit, async (req, res) => {
  const parse = signupSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({
      error: "Invalid request payload",
      details: parse.error.flatten().fieldErrors
    });
  }

  const { email, password, companyName } = parse.data;
  const emailLower = email.toLowerCase();

  // Check if user already exists
  const existing = await prisma.user.findUnique({
    where: { email: emailLower },
    select: { id: true }
  });

  if (existing) {
    return res.status(409).json({
      error: "User already exists",
      message: "This email is already registered. Please login instead."
    });
  }

  const passwordHash = bcrypt.hashSync(password, 12);

  try {
    // Create workspace for the new customer (with unique slug handling)
    const slug = await generateUniqueSlug(companyName);
    const workspace = await prisma.workspace.create({
      data: {
        name: companyName,
        slug,
        status: "active"
      }
    });

    // Create user as client role
    const user = await prisma.user.create({
      data: {
        email: emailLower,
        passwordHash,
        role: "client",
        companyName,
        workspaceId: workspace.id
      }
    });

    await logAudit(user.id, "SIGNUP_SUCCESS", { email: emailLower, companyName });

    // Issue JWT with workspaceId
    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, companyName: user.companyName, workspaceId: user.workspaceId },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    return res.status(201).json({
      message: "Account created successfully",
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        companyName: user.companyName,
        workspaceId: user.workspaceId
      }
    });
  } catch (err) {
    console.error("[Auth] Signup error:", err);
    await logAudit(null, "SIGNUP_FAILED", { email: emailLower, error: err.message });

    return res.status(500).json({
      error: "Signup failed",
      message: "An error occurred during account creation. Please try again."
    });
  }
});

router.post("/login", authRateLimit, async (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { email, password } = parse.data;

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, passwordHash: true, role: true, companyName: true, whatsappPhone: true, workspaceId: true, twoFactorEnabled: true }
  });

  const hashToCheck = user ? user.passwordHash : DUMMY_HASH;
  const isValidPassword = bcrypt.compareSync(password, hashToCheck);

  if (!user || !isValidPassword) {
    await logAudit(null, "LOGIN_FAILED", { email: email.toLowerCase() });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Si 2FA TOTP est activée, demander le code TOTP
  if (user.twoFactorEnabled) {
    const tempToken = jwt.sign(
      { sub: user.id, purpose: "2fa", type: "totp" },
      config.jwtSecret,
      { expiresIn: "5m" }
    );
    return res.json({ requires2FA: true, tempToken, type: "totp" });
  }

  // Sinon, login direct (pas de 2FA)
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, companyName: user.companyName, workspaceId: user.workspaceId },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  await logAudit(user.id, "LOGIN_SUCCESS", { email: user.email });

  return res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, companyName: user.companyName, whatsappPhone: user.whatsappPhone, workspaceId: user.workspaceId, twoFactorEnabled: user.twoFactorEnabled }
  });
});

// ─── Verify 2FA code after login ────────────────────────────

const verify2FASchema = z.object({
  tempToken: z.string(),
  code: z.string().length(6),
});

router.post("/verify-2fa", authRateLimit, async (req, res) => {
  const parse = verify2FASchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { tempToken, code } = parse.data;

  let payload;
  try {
    payload = jwt.verify(tempToken, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: "Token 2FA expiré ou invalide" });
  }

  if (payload.purpose !== "2fa") {
    return res.status(401).json({ error: "Token invalide" });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, role: true, companyName: true, whatsappPhone: true, workspaceId: true, twoFactorSecret: true, twoFactorEnabled: true },
  });

  if (!user) {
    return res.status(401).json({ error: "Utilisateur introuvable" });
  }

  // TOTP 2FA (type === "totp")
  if (payload.type === "totp") {
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(401).json({ error: "2FA TOTP non configuré" });
    }

    const isValid = totp.verify({ secret: user.twoFactorSecret, encoding: "ascii", token: code });

    if (!isValid) {
      await logAudit(user.id, "2FA_FAILED", { email: user.email, type: "totp" });
      return res.status(401).json({ error: "Code 2FA invalide" });
    }
  }
  // EMAIL 2FA (type === "email")
  else if (payload.type === "email") {
    const stored = twoFactorCodes.get(user.id);

    if (!stored || stored.type !== "email") {
      return res.status(401).json({ error: "Pas de code 2FA email en attente" });
    }

    if (stored.expiresAt < Date.now()) {
      twoFactorCodes.delete(user.id);
      return res.status(401).json({ error: "Code expiré, veuillez vous reconnecter" });
    }

    if (stored.code !== code) {
      await logAudit(user.id, "2FA_FAILED", { email: user.email, type: "email" });
      return res.status(401).json({ error: "Code incorrect" });
    }

    // Code correct, supprimer le code utilisé
    twoFactorCodes.delete(user.id);
  }
  else {
    return res.status(401).json({ error: "Type 2FA invalide" });
  }

  // Générer le token de session
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, companyName: user.companyName, workspaceId: user.workspaceId },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  await logAudit(user.id, "LOGIN_2FA", { email: user.email, type: payload.type });

  return res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, companyName: user.companyName, whatsappPhone: user.whatsappPhone, workspaceId: user.workspaceId, twoFactorEnabled: user.twoFactorEnabled }
  });
});

// ─── Accept workspace invitation ────────────────────────────────

const acceptInvitationSchema = z.object({
  token: z.string(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(200).optional()
});

router.post("/accept-invitation", authRateLimit, async (req, res) => {
  const parse = acceptInvitationSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({
      error: "Invalid request payload",
      details: parse.error.flatten().fieldErrors
    });
  }

  const { token, password, name } = parse.data;

  try {
    // Find and validate invitation
    const invitation = await prisma.workspaceInvitation.findUnique({
      where: { token }
    });

    if (!invitation) {
      return res.status(404).json({
        error: "Invitation not found",
        message: "This invitation token does not exist or has been revoked",
        code: "INVALID_TOKEN"
      });
    }

    if (invitation.status !== "pending") {
      return res.status(410).json({
        error: `Invitation already ${invitation.status}`,
        message: `This invitation cannot be accepted (status: ${invitation.status})`,
        code: "INVITATION_INVALID"
      });
    }

    if (new Date() > invitation.expiresAt) {
      return res.status(410).json({
        error: "Invitation expired",
        message: "This invitation has expired. Please ask for a new one.",
        code: "INVITATION_EXPIRED"
      });
    }

    // Check if email already registered
    const existingUser = await prisma.user.findUnique({
      where: { email: invitation.invitedEmail }
    });

    if (existingUser) {
      return res.status(409).json({
        error: "Email already registered",
        message: "This email is already registered. Please login instead.",
        code: "USER_ALREADY_EXISTS"
      });
    }

    // Create new sub-client user
    const passwordHash = bcrypt.hashSync(password, 12);
    const newUser = await prisma.user.create({
      data: {
        email: invitation.invitedEmail,
        passwordHash,
        role: "sub_client", // Invited users are sub-clients
        companyName: name || null,
        workspaceId: invitation.workspaceId
      }
    });

    // Mark invitation as accepted
    await prisma.workspaceInvitation.update({
      where: { token },
      data: {
        status: "accepted",
        acceptedAt: new Date()
      }
    });

    await logAudit(newUser.id, "SIGNUP_VIA_INVITATION", {
      email: newUser.email,
      workspaceId: invitation.workspaceId
    });

    // Issue JWT token
    const jwtToken = jwt.sign(
      { sub: newUser.id, email: newUser.email, role: newUser.role, companyName: newUser.companyName, workspaceId: newUser.workspaceId },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    return res.status(201).json({
      message: "Account created successfully via invitation",
      token: jwtToken,
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        companyName: newUser.companyName,
        workspaceId: newUser.workspaceId
      }
    });
  } catch (err) {
    console.error("[Auth] Accept invitation error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: "Failed to accept invitation. Please try again."
    });
  }
});

// ─── POST /impersonate — Admin simulates a user ───
router.post("/impersonate", requireAuth, requireRole("admin"), async (req, res) => {
  const { targetUserId } = req.body;

  if (!targetUserId || typeof targetUserId !== "number") {
    return res.status(400).json({ error: "Invalid targetUserId" });
  }

  if (targetUserId === req.user.sub) {
    return res.status(400).json({ error: "Cannot impersonate yourself" });
  }

  // Verify target user exists
  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, email: true, role: true, companyName: true, workspaceId: true }
  });

  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Generate a unique JWT ID for this impersonation session
  const jti = randomBytes(16).toString("hex");

  // Create impersonation session
  const session = await prisma.impersonationSession.create({
    data: {
      adminId: req.user.sub,
      targetId: targetUserId,
      tokenJti: jti
    }
  });

  // Generate short-lived token (1 hour) with impersonation flag
  const impersonationToken = jwt.sign(
    {
      sub: targetUser.id,
      email: targetUser.email,
      role: targetUser.role,
      companyName: targetUser.companyName,
      workspaceId: targetUser.workspaceId,
      impersonated: true,
      adminId: req.user.sub,
      sessionId: session.id,
      jti
    },
    config.jwtSecret,
    { expiresIn: "1h" }
  );

  await logAudit(req.user.sub, "IMPERSONATE_START", {
    adminId: req.user.sub,
    targetUserId,
    targetEmail: targetUser.email
  });

  return res.json({
    token: impersonationToken,
    user: targetUser,
    message: `Impersonating ${targetUser.email}`
  });
});

// ─── DELETE /impersonate — Exit impersonation, return to admin ───
router.delete("/impersonate", requireAuth, async (req, res) => {
  // Check if current token is an impersonation token
  if (!req.user.impersonated || !req.user.adminId || !req.user.sessionId) {
    return res.status(400).json({
      error: "Not in impersonation mode",
      message: "You are not currently impersonating another user"
    });
  }

  // Get the impersonation session to confirm it exists
  const session = await prisma.impersonationSession.findUnique({
    where: { id: req.user.sessionId }
  });

  if (!session) {
    return res.status(404).json({ error: "Impersonation session not found" });
  }

  // End the session
  await prisma.impersonationSession.update({
    where: { id: session.id },
    data: { endedAt: new Date() }
  });

  // Fetch the admin user to generate a fresh token
  const adminUser = await prisma.user.findUnique({
    where: { id: req.user.adminId },
    select: { id: true, email: true, role: true, companyName: true, workspaceId: true }
  });

  if (!adminUser) {
    return res.status(500).json({ error: "Admin user not found" });
  }

  // Generate new admin token
  const newToken = jwt.sign(
    {
      sub: adminUser.id,
      email: adminUser.email,
      role: adminUser.role,
      companyName: adminUser.companyName,
      workspaceId: adminUser.workspaceId
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  await logAudit(req.user.adminId, "IMPERSONATE_END", {
    adminId: req.user.adminId,
    targetUserId: req.user.sub
  });

  return res.json({
    token: newToken,
    user: adminUser,
    message: "Exited impersonation. You are back to admin mode."
  });
});

// ─── Password Reset Tokens (In-Memory Storage) ────────────────────
// Map: token -> { userId, email, expiresAt }
const passwordResetTokens = new Map();

// Cleanup expired tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of passwordResetTokens.entries()) {
    if (data.expiresAt < now) {
      passwordResetTokens.delete(token);
    }
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password
// Request password reset (no auth required)
// ═══════════════════════════════════════════════════════════════════

const forgotPasswordSchema = z.object({
  email: z.string().email().max(254)
});

router.post("/forgot-password", authRateLimit, async (req, res) => {
  try {
    const parse = forgotPasswordSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const { email } = parse.data;

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, workspaceId: true }
    });

    if (!user) {
      // Don't reveal if user exists
      await logAudit(null, "FORGOT_PASSWORD_NONEXISTENT", { email: email.toLowerCase() });
      return res.json({
        success: true,
        message: "If this email is registered, you will receive a password reset link"
      });
    }

    // Generate reset token
    const resetToken = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour

    passwordResetTokens.set(resetToken, {
      userId: user.id,
      email: user.email,
      expiresAt
    });

    // Send reset email
    const resetUrl = `${process.env.APP_URL || 'http://localhost:5173'}/reset-password?token=${resetToken}`;

    try {
      const { renderEmailTemplate, sendEmail } = await import("../services/email/email-service.js");

      const html = renderEmailTemplate({
        title: "Réinitialisation de mot de passe",
        content: `
          <p>Vous avez demandé la réinitialisation de votre mot de passe Boatswain.</p>
          <p>Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p>
        `,
        buttonLabel: "Réinitialiser mon mot de passe",
        buttonUrl: resetUrl
      });

      await sendEmail({
        userId: user.id,
        workspaceId: user.workspaceId,
        to: user.email,
        subject: "Réinitialisation de votre mot de passe Boatswain",
        html
      });
    } catch (err) {
      console.error("[Auth] Failed to send password reset email:", err.message);
      return res.status(500).json({ error: `Failed to send reset email: ${err.message}` });
    }

    await logAudit(null, "PASSWORD_RESET_REQUESTED", { email: user.email });

    return res.json({
      success: true,
      message: "Password reset email sent"
    });
  } catch (err) {
    console.error("[Auth] Forgot password error:", err);
    return res.status(500).json({ error: "An error occurred" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/auth/reset-password
// Verify token and reset password (no auth required)
// ═══════════════════════════════════════════════════════════════════

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128)
}).refine(data => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"]
});

router.post("/reset-password", authRateLimit, async (req, res) => {
  try {
    const parse = resetPasswordSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parse.error.flatten().fieldErrors
      });
    }

    const { token, newPassword } = parse.data;

    // Validate token
    const resetData = passwordResetTokens.get(token);
    if (!resetData) {
      return res.status(401).json({ error: "Invalid or expired reset token" });
    }

    if (resetData.expiresAt < Date.now()) {
      passwordResetTokens.delete(token);
      return res.status(401).json({ error: "Reset token expired" });
    }

    // Hash new password
    const passwordHash = bcrypt.hashSync(newPassword, 12);

    // Update user
    await prisma.user.update({
      where: { id: resetData.userId },
      data: { passwordHash }
    });

    // Delete token
    passwordResetTokens.delete(token);

    await logAudit(resetData.userId, "PASSWORD_RESET", { email: resetData.email });

    // Send confirmation email
    try {
      const { renderEmailTemplate, sendEmail } = await import("../services/email/email-service.js");

      const html = renderEmailTemplate({
        title: "Mot de passe réinitialisé",
        content: `
          <p>Votre mot de passe Boatswain a été réinitialisé avec succès.</p>
          <p>Vous pouvez maintenant vous connecter à votre tableau de bord.</p>
        `,
        buttonLabel: "Se connecter",
        buttonUrl: `${process.env.APP_URL || 'http://localhost:5173'}/login`
      });

      // Fetch workspaceId for the user whose password was reset
      const user = await prisma.user.findUnique({
        where: { id: resetData.userId },
        select: { workspaceId: true }
      });

      await sendEmail({
        userId: resetData.userId,
        workspaceId: user?.workspaceId, // Use optional chaining in case user is null (though it shouldn't be here)
        to: resetData.email,
        subject: "Votre mot de passe a été réinitialisé",
        html
      });
    } catch (err) {
      console.error("[Auth] Failed to send reset confirmation:", err.message);
    }

    return res.json({
      success: true,
      message: "Password reset successfully"
    });
  } catch (err) {
    console.error("[Auth] Reset password error:", err);
    return res.status(500).json({ error: "An error occurred" });
  }
});

export default router;
