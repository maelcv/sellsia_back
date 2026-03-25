/**
 * tenant.js — Middleware d'isolation multi-tenant
 *
 * Fonctionnement :
 *   1. Vérifie que l'utilisateur est authentifié (requireAuth doit passer en premier)
 *   2. Pour les super-admins (role="admin") : bypass — req.tenantId = null
 *   3. Pour les clients (role="client" / "collaborator") : charge le tenantId depuis
 *      la DB et le stocke dans req.tenantId
 *   4. Bloque avec 500 si un client n'a pas de tenantId (anomalie de données)
 *
 * Usage :
 *   router.get("/", requireAuth, requireTenantContext, async (req, res) => {
 *     // req.tenantId est garanti non-null pour les clients
 *     // req.tenantId est null pour les admins (accès global)
 *   });
 *
 * Règle d'or dans les handlers :
 *   if (req.tenantId) {
 *     where: { tenantId: req.tenantId }   // Filtre client
 *   }
 *   // Si req.tenantId est null → admin, pas de filtre tenant
 */

import { prisma } from "../prisma.js";

/**
 * Middleware principal : résout et injecte req.tenantId.
 * À placer après requireAuth sur toutes les routes protégées.
 */
export async function requireTenantContext(req, res, next) {
  try {
    // Vérification de base : requireAuth doit être passé avant
    if (!req.user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    // Super-admin plateforme : bypass de l'isolation tenant
    // Il voit les données de tous les tenants, permissions toutes actives
    if (req.user.role === "admin") {
      req.tenantId = null;
      req.tenantParentId = null;
      req.tenantPlan = null; // Les admins bypasse requireFeature de toute façon
      return next();
    }

    const userId = req.user.sub;
    if (!userId) {
      return res.status(401).json({ error: "Token invalide : sub manquant" });
    }

    // Résoudre le tenantId : JWT d'abord, sinon DB
    let resolvedTenantId = req.user.tenantId || null;

    if (!resolvedTenantId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { tenantId: true, role: true }
      });
      if (!user) {
        return res.status(401).json({ error: "Utilisateur introuvable" });
      }
      resolvedTenantId = user.tenantId;
    }

    if (!resolvedTenantId) {
      console.error(`[TENANT] userId=${userId} (role=${req.user.role}) n'a pas de tenantId !`);
      return res.status(500).json({
        error: "Ce compte n'est associé à aucun tenant. Contactez l'administrateur."
      });
    }

    // Charger le tenant avec son plan (nécessaire pour requireFeature)
    const tenant = await prisma.tenant.findUnique({
      where: { id: resolvedTenantId },
      select: {
        id: true,
        parentTenantId: true,
        tenantPlan: {
          select: {
            id: true,
            name: true,
            permissionsJson: true,
            maxSubClients: true,
            maxUsers: true,
            maxAgents: true,
            monthlyTokenLimit: true
          }
        }
      }
    });

    if (!tenant) {
      console.error(`[TENANT] Tenant ${resolvedTenantId} introuvable en DB`);
      return res.status(500).json({ error: "Tenant introuvable. Contactez l'administrateur." });
    }

    req.tenantId = tenant.id;
    req.tenantParentId = tenant.parentTenantId || null;
    req.tenantPlan = tenant.tenantPlan
      ? {
          ...tenant.tenantPlan,
          permissions: (() => {
            try { return JSON.parse(tenant.tenantPlan.permissionsJson || "{}"); }
            catch { return {}; }
          })()
        }
      : null;

    next();

  } catch (err) {
    console.error("[TENANT] Erreur middleware tenant :", err);
    res.status(500).json({ error: "Erreur interne" });
  }
}

/**
 * Helper : vérifie qu'une ressource DB appartient bien au tenant de la requête.
 * À utiliser après un findUnique() pour valider l'ownership avant de retourner/modifier.
 *
 * @param {Object} resource - L'objet retourné par Prisma (doit avoir un champ tenantId)
 * @param {Object} req       - La requête Express (doit avoir req.tenantId)
 * @returns {boolean} true si OK
 * @throws {Error} si le tenant ne correspond pas (à transformer en 403 dans le handler)
 *
 * Exemple :
 *   const conv = await prisma.conversation.findUnique({ where: { id } });
 *   validateTenantOwnership(conv, req);  // throws si mauvais tenant
 */
export function validateTenantOwnership(resource, req) {
  // Les super-admins peuvent accéder à toutes les ressources
  if (req.user?.role === "admin") return true;

  if (!resource) {
    throw Object.assign(new Error("Ressource introuvable"), { statusCode: 404 });
  }

  if (!resource.tenantId) {
    // Ressource sans tenantId (données legacy) : accès refusé par défaut
    throw Object.assign(
      new Error("Cette ressource n'est pas associée à un tenant"),
      { statusCode: 403 }
    );
  }

  if (resource.tenantId !== req.tenantId) {
    // Tentative d'accès cross-tenant : log de sécurité + 404 (ne pas révéler l'existence)
    console.warn(
      `[SECURITY] Cross-tenant access blocked: user tenant=${req.tenantId}, resource tenant=${resource.tenantId}, userId=${req.user?.sub}`
    );
    throw Object.assign(new Error("Ressource introuvable"), { statusCode: 404 });
  }

  return true;
}
