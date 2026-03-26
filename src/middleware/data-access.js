import { prisma } from "../prisma.js";

/**
 * Charge le profil d'accès aux données de l'utilisateur courant.
 * Injecte `req.dataAccess` avec le profil complet.
 *
 * Doit être chaîné APRÈS requireAuth + requireWorkspaceContext.
 * Les super-admins ont toujours un accès global complet.
 */
export async function loadDataAccess(req, res, next) {
  // Super-admins : accès global complet
  if (req.user?.role === "admin") {
    req.dataAccess = {
      accessScope: "global",
      crmAccess: true,
      crmWrite: true,
      resources: {},
    };
    return next();
  }

  const userId = req.user?.sub;
  if (!userId) return next();

  try {
    const profile = await prisma.userDataAccessProfile.findUnique({
      where: { userId },
    });

    if (profile) {
      req.dataAccess = {
        accessScope: profile.accessScope,
        crmAccess: profile.crmAccess,
        crmWrite: profile.crmWrite,
        resources: JSON.parse(profile.resourcesJson || "{}"),
      };
    } else {
      // Pas de profil = accès personnel par défaut, pas de CRM
      req.dataAccess = {
        accessScope: "personal",
        crmAccess: false,
        crmWrite: false,
        resources: {},
      };
    }
  } catch (err) {
    console.error("Failed to load data access profile:", err);
    req.dataAccess = {
      accessScope: "personal",
      crmAccess: false,
      crmWrite: false,
      resources: {},
    };
  }

  return next();
}

/**
 * Middleware factory : vérifie que l'utilisateur a un accès spécifique.
 *
 * @param {"crm_read"|"crm_write"} accessType
 */
export function requireDataAccess(accessType) {
  return (req, res, next) => {
    if (req.user?.role === "admin") return next();

    const da = req.dataAccess;
    if (!da) {
      return res.status(403).json({ error: "Profil d'accès non chargé" });
    }

    switch (accessType) {
      case "crm_read":
        if (!da.crmAccess) {
          return res.status(403).json({ error: "Accès CRM non autorisé" });
        }
        break;
      case "crm_write":
        if (!da.crmWrite) {
          return res.status(403).json({ error: "Écriture CRM non autorisée" });
        }
        break;
    }

    return next();
  };
}

/**
 * Helper : retourne un filtre Prisma WHERE pour scoper les données
 * selon le profil d'accès de l'utilisateur.
 *
 * @param {object} req - Express request avec req.dataAccess et req.user
 * @returns {{ userId?: number, workspaceId?: string }} filtre à merger dans le WHERE Prisma
 */
export function getDataScopeFilter(req) {
  if (req.user?.role === "admin") return {};

  const scope = req.dataAccess?.accessScope || "personal";

  if (scope === "personal") {
    return { userId: req.user.sub };
  }

  // "global" ou "custom" : filtre par workspace
  if (req.workspaceId) {
    return { workspaceId: req.workspaceId };
  }

  return { userId: req.user.sub };
}
