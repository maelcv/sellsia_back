/**
 * tenant.js — Middleware d'isolation multi-workspace
 *
 * Fonctionnement :
 *   1. Vérifie que l'utilisateur est authentifié (requireAuth doit passer en premier)
 *   2. Pour les super-admins (role="admin") : bypass — req.workspaceId = null
 *   3. Pour les clients/sub-clients (role="client" / "sub_client") : charge le workspaceId depuis
 *      la DB et le stocke dans req.workspaceId
 *   4. Bloque avec 400 si un client n'a pas de workspaceId (onboarding incomplet)
 *
 * Usage :
 *   router.get("/", requireAuth, requireWorkspaceContext, async (req, res) => {
 *     // req.workspaceId est garanti non-null pour les clients
 *     // req.workspaceId est null pour les admins (accès global)
 *   });
 *
 * Règle d'or dans les handlers :
 *   if (req.workspaceId) {
 *     where: { workspaceId: req.workspaceId }   // Filtre client
 *   }
 *   // Si req.workspaceId est null → admin, pas de filtre workspace
 */

import { prisma } from "../prisma.js";

/**
 * Middleware principal : résout et injecte req.workspaceId.
 * À placer après requireAuth sur toutes les routes protégées.
 */
export async function requireWorkspaceContext(req, res, next) {
  try {
    // Vérification de base : requireAuth doit être passé avant
    if (!req.user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    // Super-admin plateforme : bypass de l'isolation workspace
    // Il voit les données de tous les workspaces, permissions toutes actives
    if (req.user.role === "admin") {
      req.workspaceId = null;
      req.workspaceParentId = null;
      req.workspacePlan = null; // Les admins bypass requireFeature de toute façon
      return next();
    }

    const userId = req.user.sub;
    if (!userId) {
      return res.status(401).json({ error: "Token invalide : sub manquant" });
    }

    // Résoudre le workspaceId : JWT d'abord, sinon DB
    let resolvedWorkspaceId = req.user.workspaceId || null;

    if (!resolvedWorkspaceId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { workspaceId: true, role: true }
      });
      if (!user) {
        return res.status(401).json({ error: "Utilisateur introuvable" });
      }
      resolvedWorkspaceId = user.workspaceId;
    }

    if (!resolvedWorkspaceId) {
      console.warn(`[WORKSPACE] userId=${userId} (role=${req.user.role}) n'a pas de workspaceId - this may be normal during onboarding`);
      // For non-admin users without a workspace, return 400 instead of 500
      // This indicates the user needs to complete onboarding
      return res.status(400).json({
        error: "Account not fully configured",
        code: "NO_WORKSPACE",
        message: "Your account needs to be linked to a workspace. Please contact support or complete your profile setup.",
        hint: "If you just signed up, your workspace should be created automatically. Please refresh the page."
      });
    }

    // Charger le workspace avec son plan (nécessaire pour requireFeature)
    const workspace = await prisma.workspace.findUnique({
      where: { id: resolvedWorkspaceId },
      select: {
        id: true,
        parentWorkspaceId: true,
        workspacePlan: {
          select: {
            id: true,
            name: true,
            permissionsJson: true,
            maxSubClients: true,
            maxUsers: true,
            maxAgents: true,
            monthlyTokenLimit: true,
            allowedAgents: {
              select: { id: true }
            }
          }
        }
      }
    });

    if (!workspace) {
      console.error(`[WORKSPACE] Workspace ${resolvedWorkspaceId} introuvable en DB`);
      return res.status(500).json({ error: "Workspace introuvable. Contactez l'administrateur." });
    }

    req.workspaceId = workspace.id;
    req.workspaceParentId = workspace.parentWorkspaceId || null;

    // Parse permissions with strict validation (fail-closed on corruption)
    let parsedPermissions = {};
    if (workspace.workspacePlan?.permissionsJson) {
      try {
        const parsed = JSON.parse(workspace.workspacePlan.permissionsJson);
        if (typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedPermissions = parsed;
        } else {
          throw new Error("Permissions must be a JSON object, not array or primitive");
        }
      } catch (err) {
        console.error(
          `[WORKSPACE] Failed to parse permissionsJson for workspace ${req.workspaceId}:`,
          err.message
        );
        // Fail-closed: if permissions are corrupted, block all features
        parsedPermissions = null;
      }
    }

    req.workspacePlan = workspace.workspacePlan
      ? {
          ...workspace.workspacePlan,
          permissions: parsedPermissions
        }
      : null;

    req.allowedAgentIds = req.workspacePlan?.allowedAgents?.map(a => a.id) || [];

    next();

  } catch (err) {
    console.error("[WORKSPACE] Erreur middleware workspace :", err);
    res.status(500).json({ error: "Erreur interne" });
  }
}

/**
 * Helper : vérifie qu'une ressource DB appartient bien au workspace de la requête.
 * À utiliser après un findUnique() pour valider l'ownership avant de retourner/modifier.
 *
 * @param {Object} resource - L'objet retourné par Prisma (doit avoir un champ workspaceId)
 * @param {Object} req       - La requête Express (doit avoir req.workspaceId)
 * @returns {boolean} true si OK
 * @throws {Error} si le workspace ne correspond pas (à transformer en 403 dans le handler)
 *
 * Exemple :
 *   const conv = await prisma.conversation.findUnique({ where: { id } });
 *   validateWorkspaceOwnership(conv, req);  // throws si mauvais workspace
 */
export function validateWorkspaceOwnership(resource, req) {
  // Les super-admins peuvent accéder à toutes les ressources
  if (req.user?.role === "admin") return true;

  if (!resource) {
    throw Object.assign(new Error("Ressource introuvable"), { statusCode: 404 });
  }

  if (!resource.workspaceId) {
    // Ressource sans workspaceId (données legacy) : accès refusé par défaut
    throw Object.assign(
      new Error("Cette ressource n'est pas associée à un workspace"),
      { statusCode: 403 }
    );
  }

  if (resource.workspaceId !== req.workspaceId) {
    // Tentative d'accès cross-workspace : log de sécurité + 404 (ne pas révéler l'existence)
    console.warn(
      `[SECURITY] Cross-workspace access blocked: user workspace=${req.workspaceId}, resource workspace=${resource.workspaceId}, userId=${req.user?.sub}`
    );
    throw Object.assign(new Error("Ressource introuvable"), { statusCode: 404 });
  }

  return true;
}
