import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function requireAuth(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [, token] = authorization.split(" ");

  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

/**
 * Vérifie qu'un feature est activé dans le plan du workspace courant.
 *
 * Doit être utilisé APRÈS requireWorkspaceContext (qui charge req.workspacePlan).
 * Les super-admins (role="admin") bypasse toujours cette vérification.
 *
 * Comportement fail-closed: un workspace sans plan assigné se voit refuser l'accès.
 * Exception: /api/chat retourne un message user-friendly plutôt qu'un 403.
 *
 * @param {string} featureName - Clé du plan (ex: "ai_provider", "agents_local", ...)
 *
 * Exemple :
 *   router.post("/import", requireAuth, requireWorkspaceContext, requireFeature("agents_cloud"), ...)
 */
export function requireFeature(featureName) {
  return (req, res, next) => {
    // Super-admins : bypass total
    if (req.user?.role === "admin") return next();

    // Fail-closed: workspace sans plan assigné
    if (!req.workspacePlan) {
      // Special case for chat: return user-friendly message instead of 403
      if (req.path === "/ask" || req.path === "/stream") {
        return res.status(403).json({
          error: "Aucun fournisseur IA n'a été configuré",
          message: "Veuillez vous rapprocher de votre administrateur pour configurer un fournisseur IA.",
          feature: featureName
        });
      }
      return res.status(403).json({
        error: `Feature '${featureName}' non disponible sur votre plan`,
        feature: featureName,
        plan: null
      });
    }

    const perms = req.workspacePlan.permissions;

    // Fail-closed if permissions are corrupted/null (would be null if JSON parse failed)
    if (perms === null) {
      return res.status(500).json({
        error: "Access control configuration error",
        message: "Cannot determine feature permissions. Contact support.",
        feature: featureName
      });
    }

    if (!perms || !perms[featureName]) {
      return res.status(403).json({
        error: `Feature '${featureName}' non disponible sur votre plan`,
        feature: featureName,
        plan: req.workspacePlan.name || null
      });
    }

    return next();
  };
}
