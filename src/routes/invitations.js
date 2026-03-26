/**
 * invitations.js — API routes pour les invitations de workspace
 *
 * Routes:
 *   POST   /api/invitations            → Client invite un sub-client
 *   GET    /api/invitations            → Client liste ses invitations pending
 *   DELETE /api/invitations/:id        → Client révoque une invitation
 *   POST   /api/auth/accept-invitation → Accepter une invitation (créer compte)
 *
 * Workflow:
 *   1. Client appelle POST /api/invitations avec email
 *   2. Système génère token + envoie email
 *   3. Sub-client clique lien email
 *   4. Frontend appelle POST /api/auth/accept-invitation avec token + password
 *   5. Compte créé avec role="sub_client", même workspaceId que le client
 */

import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { sendInvitationEmail } from "../email/invitation-email.js";
import rateLimit from "express-rate-limit";

const router = Router();

// Rate limit: max 10 invitations per user per day
const inviteRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10,
  keyGenerator: (req) => `invite-${req.user.sub}`,
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many invitations",
      message: "You've sent too many invitations today. Please try again tomorrow.",
      retryAfter: "24 hours"
    });
  }
});

// Schemas
const inviteSchema = z.object({
  email: z.string().email().max(254),
  // Optional: set initial role/permissions for the sub-client
  // For now, all invited users get "sub_client" role
});

const acceptInvitationSchema = z.object({
  token: z.string(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(200).optional()
});

// --- POST /api/invitations — Client sends invitation to email ---

/**
 * Crée une invitation pour un sub-client.
 * Seuls les clients (role="client") peuvent inviter.
 *
 * Body:
 *   email (string, required) : email du sub-client à inviter
 *
 * Response:
 *   { id, workspaceId, invitedEmail, status: "pending", expiresAt, createdAt }
 */
router.post("/", requireAuth, requireWorkspaceContext, requireRole("client"), inviteRateLimit, async (req, res) => {
  const parse = inviteSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parse.error.flatten().fieldErrors
    });
  }

  const { email } = parse.data;
  const clientId = req.user.sub;
  const workspaceId = req.workspaceId;

  try {
    // Check if email already invited or exists as user in this workspace
    const existingInvite = await prisma.workspaceInvitation.findFirst({
      where: {
        invitedEmail: email,
        workspaceId,
        status: "pending"
      }
    });

    if (existingInvite) {
      return res.status(409).json({
        error: "Invitation already pending",
        message: `An invitation has already been sent to ${email} for this workspace`,
        code: "INVITE_ALREADY_SENT"
      });
    }

    // Check if email already exists as user in this workspace
    const existingUser = await prisma.user.findFirst({
      where: {
        email,
        workspaceId
      }
    });

    if (existingUser) {
      return res.status(409).json({
        error: "User already exists",
        message: `${email} is already a member of this workspace`,
        code: "USER_ALREADY_MEMBER"
      });
    }

    // Check workspace plan limits (maxUsers)
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { workspacePlan: { select: { maxUsers: true } } }
    });

    if (workspace?.workspacePlan?.maxUsers) {
      const userCount = await prisma.user.count({
        where: { workspaceId }
      });

      if (userCount >= workspace.workspacePlan.maxUsers) {
        return res.status(403).json({
          error: "Workspace user limit reached",
          message: `Your workspace has reached the maximum number of users (${workspace.workspacePlan.maxUsers})`,
          code: "MAX_USERS_REACHED"
        });
      }
    }

    // Create invitation with token
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const invitation = await prisma.workspaceInvitation.create({
      data: {
        workspaceId,
        invitedEmail: email,
        expiresAt,
        createdByUserId: clientId,
        status: "pending"
      }
    });

    // Send invitation email
    try {
      await sendInvitationEmail({
        to: email,
        workspaceName: req.workspacePlan?.name || "Your Workspace",
        inviterName: req.user.companyName || "A colleague",
        invitationToken: invitation.token,
        expiresAt
      });

      await logAudit(clientId, "INVITE_SENT", {
        email,
        workspaceId,
        invitationId: invitation.id
      });
    } catch (emailErr) {
      console.error("[Invitations] Failed to send email:", emailErr);
      // Don't fail the API call - invitation is created but email failed
      // User can retry or we can send via background job
    }

    return res.status(201).json({
      message: "Invitation sent successfully",
      invitation: {
        id: invitation.id,
        workspaceId: invitation.workspaceId,
        invitedEmail: invitation.invitedEmail,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt
      }
    });
  } catch (err) {
    console.error("[Invitations] Error creating invitation:", err);
    return res.status(500).json({ error: "Failed to create invitation" });
  }
});

// --- GET /api/invitations — Client lists pending invitations ---

/**
 * Liste les invitations pending du client pour son workspace.
 *
 * Response:
 *   { invitations: [...] }
 */
router.get("/", requireAuth, requireWorkspaceContext, requireRole("client"), async (req, res) => {
  const workspaceId = req.workspaceId;

  try {
    const invitations = await prisma.workspaceInvitation.findMany({
      where: {
        workspaceId,
        status: { in: ["pending", "accepted"] }
      },
      select: {
        id: true,
        invitedEmail: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" }
    });

    return res.json({ invitations });
  } catch (err) {
    console.error("[Invitations] Error listing invitations:", err);
    return res.status(500).json({ error: "Failed to list invitations" });
  }
});

// --- DELETE /api/invitations/:id — Client revokes invitation ---

/**
 * Révoque une invitation pending (seul le créateur peut le faire).
 */
router.delete("/:id", requireAuth, requireWorkspaceContext, requireRole("client"), async (req, res) => {
  const invitationId = req.params.id;
  const clientId = req.user.sub;
  const workspaceId = req.workspaceId;

  try {
    const invitation = await prisma.workspaceInvitation.findUnique({
      where: { id: invitationId }
    });

    if (!invitation) {
      return res.status(404).json({ error: "Invitation not found" });
    }

    // Check permissions: only creator of invitation (or workspace admin) can revoke
    if (invitation.createdByUserId !== clientId || invitation.workspaceId !== workspaceId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Only pending invitations can be revoked
    if (invitation.status !== "pending") {
      return res.status(409).json({
        error: `Cannot revoke invitation with status "${invitation.status}"`,
        message: "Only pending invitations can be revoked"
      });
    }

    // Update to revoked
    await prisma.workspaceInvitation.update({
      where: { id: invitationId },
      data: { status: "revoked" }
    });

    await logAudit(clientId, "INVITE_REVOKED", { invitationId, email: invitation.invitedEmail });

    return res.json({ message: "Invitation revoked" });
  } catch (err) {
    console.error("[Invitations] Error revoking invitation:", err);
    return res.status(500).json({ error: "Failed to revoke invitation" });
  }
});

export default router;
