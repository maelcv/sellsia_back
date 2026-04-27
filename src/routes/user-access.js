import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";

const router = Router();

// Toutes les routes nécessitent auth + tenant context
router.use(requireAuth, requireWorkspaceContext);

// ─── Schemas ────────────────────────────────────────────────

const upsertProfileSchema = z.object({
  accessScope: z.enum(["personal", "global", "custom"]),
  crmAccess: z.boolean(),
  crmWrite: z.boolean(),
  resourcesJson: z.string().optional(),
});

// ─── GET /api/user-access/:userId — Profil d'accès d'un user ──

router.get("/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) return res.status(400).json({ error: "userId invalide" });

  // Seuls les admins ou le client propriétaire du workspace peuvent voir les profils
  if (req.user.role !== "ADMIN") {
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { workspaceId: true },
    });
    if (!targetUser || targetUser.workspaceId !== req.workspaceId) {
      return res.status(403).json({ error: "Accès refusé" });
    }
  }

  const profile = await prisma.userDataAccessProfile.findUnique({
    where: { userId },
  });

  return res.json({
    profile: profile
      ? {
          ...profile,
          resources: JSON.parse(profile.resourcesJson || "{}"),
        }
      : null,
  });
});

// ─── PUT /api/user-access/:userId — Créer/modifier le profil ──

router.put("/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) return res.status(400).json({ error: "userId invalide" });

  const parsed = upsertProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Données invalides", details: parsed.error.flatten() });
  }

  // Vérifier que le target user appartient au même workspace
  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { workspaceId: true },
  });

  if (!targetUser) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  // Seuls les admins ou le client owner du workspace peuvent modifier
  if (req.user.role !== "ADMIN") {
    if (targetUser.workspaceId !== req.workspaceId) {
      return res.status(403).json({ error: "Accès refusé" });
    }
    // Un user ne peut pas modifier son propre profil d'accès (seulement l'admin du workspace)
    if (req.user.sub === userId) {
      return res.status(403).json({ error: "Vous ne pouvez pas modifier votre propre profil d'accès" });
    }
  }

  const workspaceId = targetUser.workspaceId;
  if (!workspaceId) {
    return res.status(400).json({ error: "L'utilisateur n'appartient à aucun workspace" });
  }

  const { accessScope, crmAccess, crmWrite, resourcesJson } = parsed.data;

  const profile = await prisma.userDataAccessProfile.upsert({
    where: { userId },
    create: {
      userId,
      workspaceId,
      accessScope,
      crmAccess,
      crmWrite,
      resourcesJson: resourcesJson || "{}",
    },
    update: {
      accessScope,
      crmAccess,
      crmWrite,
      resourcesJson: resourcesJson || "{}",
    },
  });

  return res.json({
    profile: {
      ...profile,
      resources: JSON.parse(profile.resourcesJson || "{}"),
    },
  });
});

// ─── GET /api/user-access/workspace/all — Tous les profils du workspace ──

router.get("/workspace/all", async (req, res) => {
  if (req.user.role !== "ADMIN" && !req.workspaceId) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  const workspaceFilter = req.user.role === "ADMIN" ? {} : { workspaceId: req.workspaceId };

  const profiles = await prisma.userDataAccessProfile.findMany({
    where: workspaceFilter,
    include: {
      user: { select: { id: true, email: true, role: true, companyName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return res.json({
    profiles: profiles.map((p) => ({
      ...p,
      resources: JSON.parse(p.resourcesJson || "{}"),
    })),
  });
});

export default router;
