/**
 * Profile & Security Routes
 * - Change password (authenticated user)
 * - 2FA email settings
 */

import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { authRateLimit } from "../middleware/security.js";
import { requireAuth } from "../middleware/auth.js";
import { sendEmail } from "../services/email/email-service.js";

import { getUserProfile, initUserProfile } from "../services/memory/user-profile.js";
import { writeRootNote, deleteRootNote } from "../services/vault/vault-service.js";

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// POST /api/profile/change-password
// Change password for authenticated user (needs old password)
// ═══════════════════════════════════════════════════════════════════

const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128)
}).refine(data => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"]
}).refine(data => data.currentPassword !== data.newPassword, {
  message: "New password must be different from current",
  path: ["newPassword"]
});

router.post("/change-password", requireAuth, authRateLimit, async (req, res) => {
  try {
    const parse = changePasswordSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parse.error.flatten().fieldErrors
      });
    }

    const { currentPassword, newPassword } = parse.data;
    const userId = req.user.sub;

    // Get current password hash
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true }
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify current password
    const isCurrentPasswordValid = bcrypt.compareSync(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      await logAudit(userId, "PASSWORD_CHANGE_FAILED", { email: user.email, reason: "Invalid current password" });
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Hash new password
    const newPasswordHash = bcrypt.hashSync(newPassword, 12);

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash }
    });

    await logAudit(userId, "PASSWORD_CHANGED", { email: user.email });

    // Send confirmation email
    try {
      await sendEmail({
        userId,
        to: user.email,
        subject: "Votre mot de passe a été changé",
        html: `
          <h2>Confirmation de changement de mot de passe</h2>
          <p>Votre mot de passe Boatswain a été changé avec succès.</p>
          <p>Si vous n'avez pas effectué cette action, veuillez <a href="${process.env.APP_URL || 'http://localhost:5173'}/forgot-password">réinitialiser votre mot de passe</a> immédiatement.</p>
        `
      });
    } catch (err) {
      console.error("[Profile] Failed to send password change confirmation:", err.message);
    }

    return res.json({
      success: true,
      message: "Password changed successfully"
    });
  } catch (err) {
    console.error("[Profile] Change password error:", err);
    return res.status(500).json({ error: "An error occurred" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/profile/toggle-2fa-email
// Enable/disable 2FA email (authenticated user)
// ═══════════════════════════════════════════════════════════════════

const toggle2FAEmailSchema = z.object({
  enabled: z.boolean()
});

router.post("/toggle-2fa-email", requireAuth, async (req, res) => {
  try {
    const parse = toggle2FAEmailSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const userId = req.user.sub;
    // For now, we always use email 2FA. In the future, add a field to User model
    // to track this preference separately from twoFactorEnabled (which is for TOTP)

    await logAudit(userId, "2FA_EMAIL_TOGGLED", { enabled: parse.data.enabled });

    return res.json({
      success: true,
      message: parse.data.enabled ? "2FA email activated" : "2FA email disabled"
    });
  } catch (err) {
    console.error("[Profile] Toggle 2FA email error:", err);
    return res.status(500).json({ error: "An error occurred" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/profile/memory
// Get the user's AI memory markdown profile
// ═══════════════════════════════════════════════════════════════════

router.get("/memory", requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    let content = await getUserProfile(userId);
    
    if (!content) {
      // If it doesn't exist, create the initial profile
      const user = await prisma.user.findUnique({ where: { id: userId } });
      content = await initUserProfile(userId, user || {});
    }
    
    return res.json({ content });
  } catch (err) {
    console.error("[Profile] Get memory error:", err);
    return res.status(500).json({ error: "Failed to load memory profile" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/profile/memory
// Update the user's AI memory markdown profile
// ═══════════════════════════════════════════════════════════════════

router.put("/memory", requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { content } = req.body;
    
    if (typeof content !== "string") {
      return res.status(400).json({ error: "Content must be a string" });
    }

    const path = `Global/Users/${userId}/profile.md`;
    await writeRootNote(path, content);
    
    return res.json({ success: true });
  } catch (err) {
    console.error("[Profile] Update memory error:", err);
    return res.status(500).json({ error: "Failed to update memory profile" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/profile/memory/reset
// Reset the user's AI memory markdown profile
// ═══════════════════════════════════════════════════════════════════

router.post("/memory/reset", requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const path = `Global/Users/${userId}/profile.md`;
    
    // Delete existing note
    try {
      await deleteRootNote(path);
    } catch (e) {
      // Ignore if not exists
    }
    
    // Re-init
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const content = await initUserProfile(userId, user || {});
    
    return res.json({ success: true, content });
  } catch (err) {
    console.error("[Profile] Reset memory error:", err);
    return res.status(500).json({ error: "Failed to reset memory profile" });
  }
});

export default router;
