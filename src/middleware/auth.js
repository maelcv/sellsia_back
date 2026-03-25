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
 * Vérifie qu'un feature est activé dans le plan du tenant courant.
 *
 * Doit être utilisé APRÈS requireTenantContext (qui charge req.tenantPlan).
 * Les super-admins (role="admin") bypasse toujours cette vérification.
 *
 * Comportement fail-open si le tenant n'a pas de plan assigné (migration progressive).
 *
 * @param {string} featureName - Clé du plan (ex: "ai_provider", "agents_local", ...)
 *
 * Exemple :
 *   router.post("/import", requireAuth, requireTenantContext, requireFeature("agents_cloud"), ...)
 */
export function requireFeature(featureName) {
  return (req, res, next) => {
    // Super-admins : bypass total
    if (req.user?.role === "admin") return next();

    // Fail-open si pas de plan assigné (tenant en cours de migration)
    if (!req.tenantPlan) return next();

    const perms = req.tenantPlan.permissions || {};
    if (!perms[featureName]) {
      return res.status(403).json({
        error: `Feature '${featureName}' non disponible sur votre plan`,
        feature: featureName,
        plan: req.tenantPlan.name || null
      });
    }

    return next();
  };
}
