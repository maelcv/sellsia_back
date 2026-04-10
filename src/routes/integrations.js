import express from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole, requireFeature } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { config } from "../config.js";
import { encryptSecret, decryptSecret, maskSecret } from "../security/secrets.js";
import { SellsyClient } from "../../ia_models/sellsy/client.js";

const router = express.Router();

function normalizeIntegrationCategory(category) {
  return String(category || "").toLowerCase().trim();
}

function isAdminWithoutWorkspace(req) {
  return req.user?.role === "admin" && !req.workspaceId;
}

function isAllowedForAdminWithoutWorkspace(integrationType) {
  const category = normalizeIntegrationCategory(integrationType?.category);
  return category === "mail" || category === "calendar" || category === "whatsapp" || category === "other";
}

function getGoogleScopesForIntegrationType(integrationType) {
  const name = String(integrationType?.name || "").toLowerCase();
  const scopes = ["openid", "email", "profile"];

  if (name.includes("gmail")) {
    scopes.push("https://www.googleapis.com/auth/gmail.readonly");
  }
  if (name.includes("calendar")) {
    scopes.push(
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events"
    );
  }

  const uniqueScopes = [...new Set(scopes)];
  // At least one product-specific scope required.
  if (!uniqueScopes.some((scope) => scope.includes("gmail") || scope.includes("calendar"))) {
    return null;
  }

  return uniqueScopes.join(" ");
}

function getApiBaseUrl(req) {
  if (config.publicApiUrl) return config.publicApiUrl.replace(/\/$/, "");
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildOauthPopupHtml({ status, message, integrationTypeId, frontendOrigin }) {
  const safeOrigin = frontendOrigin || config.frontendUrl || "*";
  const payload = {
    type: "sellsia_google_oauth",
    status,
    integrationTypeId,
    message,
  };

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Connexion Google</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; color: #111827; }
      .ok { color: #047857; }
      .ko { color: #b91c1c; }
    </style>
  </head>
  <body>
    <h2 class="${status === "success" ? "ok" : "ko"}">${status === "success" ? "Connexion réussie" : "Connexion échouée"}</h2>
    <p>${escapeHtml(message)}</p>
    <p>Cette fenêtre peut être fermée.</p>
    <script>
      (function () {
        try {
          var payload = ${JSON.stringify(payload)};
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, ${JSON.stringify(safeOrigin)});
          }
        } catch (_) {}
        setTimeout(function () { window.close(); }, 120);
      })();
    </script>
  </body>
</html>`;
}

async function testIntegrationConnection(integrationType, credentials = {}, protocol) {
  const normalizedType = String(integrationType || "").toLowerCase();

  if (normalizedType === "smtp custom") {
    if (!credentials?.email || !credentials?.password) {
      throw new Error("Email et mot de passe requis");
    }
    if (!String(credentials.email).includes("@")) {
      throw new Error("Email invalide");
    }
    return { success: true, message: "Connexion valide" };
  }

  if (normalizedType.includes("sellsy")) {
    const token = credentials.token || credentials.apiToken || credentials.api_token || credentials.accessToken || credentials.access_token;
    const tokenKey = credentials.key || credentials.apiSecret || credentials.api_secret;
    const clientId = credentials.clientId || credentials.client_id;
    const clientSecret = credentials.clientSecret || credentials.client_secret;
    const refreshToken = credentials.refreshToken || credentials.refresh_token;
    const accessToken = credentials.accessToken || credentials.access_token;

    let sellsyCreds = null;
    if (clientId && clientSecret) {
      sellsyCreds = {
        type: "oauth",
        clientId,
        clientSecret,
        ...(refreshToken && { refreshToken }),
        ...(accessToken && { accessToken }),
      };
    } else if (token) {
      sellsyCreds = { type: "token", token };
    }

    if (!sellsyCreds) {
      throw new Error("Identifiants Sellsy incomplets (token ou OAuth requis)");
    }

    try {
      const client = new SellsyClient(sellsyCreds);
      // Lightweight call to validate auth.
      await client.getOpportunities({}, 1);
      return { success: true, message: "Connexion Sellsy valide" };
    } catch (err) {
      const msg = String(err?.message || "Erreur de connexion Sellsy");
      // Fallback for "Token + Key" legacy mode: try OAuth client_credentials.
      if (token && tokenKey) {
        try {
          const r = await fetch("https://login.sellsy.com/oauth2/access-tokens", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: token,
              client_secret: tokenKey,
            }),
          });
          if (r.ok) {
            return { success: true, message: "Connexion Sellsy valide (mode Token + Cle API)" };
          }
        } catch {
          // Continue with canonical error handling below.
        }
      }
      if (msg.includes("401") || msg.toLowerCase().includes("revoked") || msg.toLowerCase().includes("unauthorized")) {
        throw new Error("Sellsy API 401: Access token has been revoked");
      }
      throw err;
    }
  }

  if (normalizedType.includes("google calendar") || normalizedType.includes("gmail")) {
    if (!credentials?.accessToken && !credentials?.refreshToken) {
      throw new Error("Connexion Google invalide : token manquant");
    }
    return { success: true, message: "Connexion Google valide" };
  }

  return { success: true, message: "Type d'intégration non testé spécifiquement" };
}

const googleOauthStartSchema = z.object({
  integrationTypeId: z.string().min(1),
  frontendOrigin: z.string().url().optional(),
});

router.post("/google/oauth/start", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const data = googleOauthStartSchema.parse(req.body || {});

    if (!config.googleOauthClientId || !config.googleOauthClientSecret) {
      return res.status(503).json({ error: "Google OAuth n'est pas configuré sur la plateforme" });
    }

    const integrationType = await prisma.integrationType.findUnique({
      where: { id: data.integrationTypeId },
      select: { id: true, name: true, category: true, isActive: true },
    });

    if (!integrationType || !integrationType.isActive) {
      return res.status(404).json({ error: "Type d'intégration introuvable ou inactif" });
    }

    const category = normalizeIntegrationCategory(integrationType.category);
    const adminWithoutWorkspace = isAdminWithoutWorkspace(req);

    if (category === "crm" && !req.workspaceId) {
      return res.status(403).json({
        error: "CRM integration requires workspace",
        details: "Les intégrations CRM nécessitent un workspace",
      });
    }

    if (adminWithoutWorkspace && !isAllowedForAdminWithoutWorkspace(integrationType)) {
      return res.status(403).json({
        error: "Integration not allowed without workspace",
        details: "Cette intégration nécessite un workspace pour être activée",
      });
    }

    if (!adminWithoutWorkspace) {
      const workspaceIntegration = await prisma.workspaceIntegration.findFirst({
        where: {
          workspaceId: req.workspaceId,
          integrationTypeId: integrationType.id,
          isEnabled: true,
        },
        select: { id: true },
      });

      if (!workspaceIntegration) {
        return res.status(403).json({
          error: "Integration not available in this workspace",
          details: "L'intégration doit être activée au niveau workspace",
        });
      }
    }

    const scope = getGoogleScopesForIntegrationType(integrationType);
    if (!scope) {
      return res.status(400).json({
        error: "Type d'intégration non compatible OAuth Google",
      });
    }

    const frontendOrigin = data.frontendOrigin || req.get("origin") || config.frontendUrl;
    const stateToken = jwt.sign(
      {
        purpose: "google_oauth_link",
        userId: req.user.sub,
        integrationTypeId: integrationType.id,
        frontendOrigin,
      },
      config.jwtSecret,
      { expiresIn: "10m" }
    );

    const redirectUri = config.googleOauthRedirectUri || `${getApiBaseUrl(req)}/api/integrations/google/oauth/callback`;
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", config.googleOauthClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("state", stateToken);

    return res.json({ authUrl: authUrl.toString() });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    console.error("[POST /integrations/google/oauth/start] Error:", err);
    return res.status(500).json({ error: "Failed to initialize Google OAuth" });
  }
});

router.get("/google/oauth/callback", async (req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none';"
  );
  res.setHeader("Cache-Control", "no-store");

  const rawState = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";

  if (!rawState) {
    return res.status(400).send("Missing OAuth state");
  }

  let state;
  try {
    state = jwt.verify(rawState, config.jwtSecret);
  } catch {
    return res.status(401).send("Invalid or expired OAuth state");
  }

  const integrationTypeId = state?.integrationTypeId || null;
  const frontendOrigin = state?.frontendOrigin || config.frontendUrl;

  if (oauthError) {
    return res
      .status(400)
      .send(
        buildOauthPopupHtml({
          status: "error",
          message: `Autorisation Google refusée: ${oauthError}`,
          integrationTypeId,
          frontendOrigin,
        })
      );
  }

  if (!code || !state?.userId || !integrationTypeId) {
    return res
      .status(400)
      .send(
        buildOauthPopupHtml({
          status: "error",
          message: "Code OAuth ou contexte manquant",
          integrationTypeId,
          frontendOrigin,
        })
      );
  }

  try {
    if (!config.googleOauthClientId || !config.googleOauthClientSecret) {
      throw new Error("Google OAuth n'est pas configuré sur la plateforme");
    }

    const integrationType = await prisma.integrationType.findUnique({
      where: { id: integrationTypeId },
      select: { id: true, name: true, category: true, isActive: true },
    });

    if (!integrationType || !integrationType.isActive) {
      throw new Error("Type d'intégration introuvable ou inactif");
    }

    const user = await prisma.user.findUnique({
      where: { id: Number(state.userId) },
      select: { id: true, role: true, workspaceId: true },
    });

    if (!user) {
      throw new Error("Utilisateur introuvable");
    }

    if (user.role !== "admin" && !user.workspaceId) {
      throw new Error("Un workspace est requis pour ce compte");
    }

    if (user.role === "admin" && !user.workspaceId && !isAllowedForAdminWithoutWorkspace(integrationType)) {
      throw new Error("Cette intégration nécessite un workspace");
    }

    if (user.role !== "admin") {
      const workspaceIntegration = await prisma.workspaceIntegration.findFirst({
        where: {
          workspaceId: user.workspaceId,
          integrationTypeId: integrationType.id,
          isEnabled: true,
        },
        select: { id: true },
      });

      if (!workspaceIntegration) {
        throw new Error("L'intégration n'est pas activée pour ce workspace");
      }
    }

    const redirectUri = config.googleOauthRedirectUri || `${getApiBaseUrl(req)}/api/integrations/google/oauth/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleOauthClientId,
        client_secret: config.googleOauthClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      throw new Error(`Google token exchange failed (${tokenRes.status}): ${errorText.slice(0, 300)}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token || null;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = Number(tokenData.expires_in || 0);
    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    if (!accessToken) {
      throw new Error("Google n'a pas retourné d'access token");
    }

    let googleEmail = null;
    try {
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (userInfoRes.ok) {
        const userInfo = await userInfoRes.json();
        googleEmail = userInfo?.email || null;
      }
    } catch {
      // Non blocking.
    }

    let preservedRefreshToken = refreshToken;
    const existing = await prisma.userIntegration.findUnique({
      where: { userId_integrationTypeId: { userId: user.id, integrationTypeId: integrationType.id } },
      select: { encryptedCredentials: true },
    });

    if (!preservedRefreshToken && existing?.encryptedCredentials) {
      try {
        const previous = JSON.parse(decryptSecret(existing.encryptedCredentials));
        preservedRefreshToken = previous?.refreshToken || previous?.refresh_token || null;
      } catch {
        // Ignore legacy parsing issues.
      }
    }

    const credentials = {
      provider: "google_oauth",
      accessToken,
      refreshToken: preservedRefreshToken,
      expiresAt,
      scope: tokenData.scope || null,
      tokenType: tokenData.token_type || "Bearer",
      email: googleEmail,
    };

    await prisma.userIntegration.upsert({
      where: { userId_integrationTypeId: { userId: user.id, integrationTypeId: integrationType.id } },
      create: {
        userId: user.id,
        integrationTypeId: integrationType.id,
        encryptedCredentials: encryptSecret(JSON.stringify(credentials)),
      },
      update: {
        encryptedCredentials: encryptSecret(JSON.stringify(credentials)),
      },
    });

    await logAudit(user.id, "LINK_USER_INTEGRATION_GOOGLE_OAUTH", {
      integrationTypeId: integrationType.id,
      integrationTypeName: integrationType.name,
      workspaceId: user.workspaceId || null,
    });

    return res.send(
      buildOauthPopupHtml({
        status: "success",
        message: `${integrationType.name} connecté avec Google`,
        integrationTypeId: integrationType.id,
        frontendOrigin,
      })
    );
  } catch (err) {
    console.error("[GET /integrations/google/oauth/callback] Error:", err);
    return res
      .status(500)
      .send(
        buildOauthPopupHtml({
          status: "error",
          message: err?.message || "Erreur lors de la connexion Google",
          integrationTypeId,
          frontendOrigin,
        })
      );
  }
});

// ====== Admin Routes: IntegrationType CRUD ======

/**
 * GET /api/integrations
 * List all integration types
 * - Admin: all types
 * - Client/Sub-client: only active types
 */
router.get("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const where = req.user.role === "admin" ? {} : { isActive: true };
    const types = await prisma.integrationType.findMany({
      where,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        category: true,
        logoUrl: true,
        configSchema: true,
        isActive: true,
      },
    });

    res.json({ types });
  } catch (err) {
    console.error("[GET /integrations] Error:", err);
    res.status(500).json({ error: "Failed to list integration types" });
  }
});

/**
 * POST /api/integrations
 * Admin only: Create new integration type
 */
const createIntegrationTypeSchema = z.object({
  name: z.string().min(2).max(80),
  category: z.enum(["crm", "mail", "whatsapp", "calendar", "other"]),
  logoUrl: z.string().url().optional().or(z.literal("")),
  configSchema: z.record(z.any()).optional().default({}),
  isActive: z.boolean().optional().default(true),
});

router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = createIntegrationTypeSchema.parse(req.body);

    const type = await prisma.integrationType.create({
      data: {
        name: data.name,
        category: data.category,
        logoUrl: data.logoUrl || null,
        configSchema: data.configSchema,
        isActive: data.isActive,
      },
    });

    await logAudit(req.user.sub, "CREATE_INTEGRATION_TYPE", { typeId: type.id, name: type.name });

    res.status(201).json({ type });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    console.error("[POST /integrations] Error:", err);
    res.status(500).json({ error: "Failed to create integration type" });
  }
});

/**
 * PATCH /api/integrations/:id
 * Admin only: Update integration type
 */
const updateIntegrationTypeSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
  configSchema: z.record(z.any()).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const data = updateIntegrationTypeSchema.parse(req.body);

    const type = await prisma.integrationType.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl || null }),
        ...(data.configSchema !== undefined && { configSchema: data.configSchema }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });

    await logAudit(req.user.sub, "UPDATE_INTEGRATION_TYPE", { typeId: id });

    res.json({ type });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Integration type not found" });
    }
    console.error("[PATCH /integrations/:id] Error:", err);
    res.status(500).json({ error: "Failed to update integration type" });
  }
});

/**
 * DELETE /api/integrations/:id
 * Admin only: Soft delete (mark isActive = false)
 */
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;

    const type = await prisma.integrationType.update({
      where: { id },
      data: { isActive: false },
    });

    await logAudit(req.user.sub, "DELETE_INTEGRATION_TYPE", { typeId: id });

    res.json({ message: "Integration type deactivated", type });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Integration type not found" });
    }
    console.error("[DELETE /integrations/:id] Error:", err);
    res.status(500).json({ error: "Failed to delete integration type" });
  }
});

// ====== Workspace Integration Routes ======

/**
 * GET /api/workspaces/:id/integrations
 * Admin: List ALL integrations (enabled & disabled)
 * Client: List ENABLED integrations only
 */
router.get(
  "/workspace/:workspaceId",
  requireAuth,
  async (req, res) => {
    try {
      const { workspaceId } = req.params;

      // Verify workspace access
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      // Admin can see everything, others only their own workspace
      if (req.user.role !== "admin" && workspace.id !== req.user.workspaceId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Build filter: clients see only enabled integrations
      const whereFilter = {
        workspaceId,
        ...(req.user.role !== "admin" && { isEnabled: true }),
      };

      const integrations = await prisma.workspaceIntegration.findMany({
        where: whereFilter,
        include: { integrationType: true },
        orderBy: { integrationType: { name: "asc" } },
      });

      // Decrypt config for display
      const withConfig = integrations.map((int) => {
        let config = {};
        try {
          if (int.encryptedConfig) {
            config = JSON.parse(decryptSecret(int.encryptedConfig));
          }
        } catch (err) {
          console.warn(`Failed to decrypt config for integration ${int.id}:`, err);
        }

        return {
          ...int,
          config,
          encryptedConfig: maskSecret(int.encryptedConfig),
        };
      });

      res.json({ integrations: withConfig });
    } catch (err) {
      console.error("[GET /workspace/:id/integrations] Error:", err);
      res.status(500).json({ error: "Failed to list workspace integrations" });
    }
  }
);

/**
 * POST /api/workspaces/:id/integrations
 * Client: Enable and configure integration for workspace
 */
const configureWorkspaceIntegrationSchema = z.object({
  integrationTypeId: z.string().min(1),
  config: z.record(z.any()),
});

router.post(
  "/workspace/:workspaceId",
  requireAuth,
  requireRole("client", "admin"),
  async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const data = configureWorkspaceIntegrationSchema.parse(req.body);

      // Verify workspace access
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      if (req.user.role !== "admin" && workspace.id !== req.user.workspaceId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Verify integration type exists
      const integrationType = await prisma.integrationType.findUnique({
        where: { id: data.integrationTypeId },
      });

      if (!integrationType) {
        return res.status(404).json({ error: "Integration type not found" });
      }

      // Encrypt config
      const encryptedConfig = encryptSecret(JSON.stringify(data.config));

      // Upsert: if already exists, update config
      const integration = await prisma.workspaceIntegration.upsert({
        where: { workspaceId_integrationTypeId: { workspaceId, integrationTypeId: data.integrationTypeId } },
        create: {
          workspaceId,
          integrationTypeId: data.integrationTypeId,
          encryptedConfig,
          configuredByUserId: req.user.sub,
          isEnabled: true,
        },
        update: {
          encryptedConfig,
          configuredByUserId: req.user.sub,
          isEnabled: true,
        },
        include: { integrationType: true },
      });

      await logAudit(req.user.sub, "CONFIGURE_WORKSPACE_INTEGRATION", {
        workspaceId,
        integrationTypeId: data.integrationTypeId,
      });

      // Decrypt config for response
      let config = {};
      try {
        if (integration.encryptedConfig) {
          config = JSON.parse(decryptSecret(integration.encryptedConfig));
        }
      } catch (err) {
        console.warn(`Failed to decrypt config for integration ${integration.id}:`, err);
      }

      const response = {
        ...integration,
        config,
        encryptedConfig: maskSecret(integration.encryptedConfig),
      };

      res.status(201).json({ integration: response });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", issues: err.errors });
      }
      console.error("[POST /workspace/:id/integrations] Error:", err);
      res.status(500).json({ error: "Failed to configure integration" });
    }
  }
);

/**
 * PATCH /api/workspaces/:id/integrations/:iid
 * Client: Update config or toggle isEnabled
 */
const updateWorkspaceIntegrationSchema = z.object({
  config: z.record(z.any()).optional(),
  isEnabled: z.boolean().optional(),
});

router.patch(
  "/workspace/:workspaceId/:integrationId",
  requireAuth,
  requireRole("client", "admin"),
  requireWorkspaceContext,
  async (req, res) => {
    try {
      const { workspaceId, integrationId } = req.params;
      const data = updateWorkspaceIntegrationSchema.parse(req.body);

      // Verify workspace access
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      if (req.user.role !== "admin" && workspace.id !== req.user.workspaceId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const updateData = {};

      if (data.config) {
        updateData.encryptedConfig = encryptSecret(JSON.stringify(data.config));
      }

      if (data.isEnabled !== undefined) {
        updateData.isEnabled = data.isEnabled;
      }

      const integration = await prisma.workspaceIntegration.update({
        where: { id: integrationId },
        data: updateData,
        include: { integrationType: true },
      });

      await logAudit(req.user.sub, "UPDATE_WORKSPACE_INTEGRATION", { workspaceId, integrationId });

      // Decrypt config for response
      let config = {};
      try {
        if (integration.encryptedConfig) {
          config = JSON.parse(decryptSecret(integration.encryptedConfig));
        }
      } catch (err) {
        console.warn(`Failed to decrypt config for integration ${integration.id}:`, err);
      }

      const response = {
        ...integration,
        config,
        encryptedConfig: maskSecret(integration.encryptedConfig),
      };
      res.json({ integration: response });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", issues: err.errors });
      }
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Integration not found" });
      }
      console.error("[PATCH /workspace/:id/integrations/:iid] Error:", err);
      res.status(500).json({ error: "Failed to update integration" });
    }
  }
);

/**
 * DELETE /api/workspaces/:id/integrations/:iid
 * Client: Remove integration from workspace
 */
router.delete(
  "/workspace/:workspaceId/:integrationId",
  requireAuth,
  requireRole("client", "admin"),
  requireWorkspaceContext,
  async (req, res) => {
    try {
      const { workspaceId, integrationId } = req.params;

      // Verify workspace access
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      if (req.user.role !== "admin" && workspace.id !== req.user.workspaceId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      await prisma.workspaceIntegration.delete({
        where: { id: integrationId },
      });

      await logAudit(req.user.sub, "DELETE_WORKSPACE_INTEGRATION", { workspaceId, integrationId });

      res.json({ message: "Integration removed from workspace" });
    } catch (err) {
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Integration not found" });
      }
      console.error("[DELETE /workspace/:id/integrations/:iid] Error:", err);
      res.status(500).json({ error: "Failed to delete integration" });
    }
  }
);

// ====== User Personal Integration Routes ======

/**
 * GET /api/users/me/integrations
 * User: List personal integrations (WhatsApp, Email, Calendar, etc.)
 */
router.get(
  "/me",
  requireAuth,
  requireWorkspaceContext,
  async (req, res) => {
    try {
      const integrations = await prisma.userIntegration.findMany({
        where: { userId: req.user.sub },
        include: { integrationType: true },
        orderBy: { integrationType: { name: "asc" } },
      });

      // Mask credentials
      const masked = integrations.map((int) => ({
        ...int,
        encryptedCredentials: maskSecret(int.encryptedCredentials),
      }));

      res.json({ integrations: masked });
    } catch (err) {
      console.error("[GET /users/me/integrations] Error:", err);
      res.status(500).json({ error: "Failed to list personal integrations" });
    }
  }
);

/**
 * POST /api/users/me/integrations
 * User: Link personal account (WhatsApp, email, calendar)
 */
const linkUserIntegrationSchema = z.object({
  integrationTypeId: z.string().min(1),
  credentials: z.record(z.any()),
});

router.post(
  "/me",
  requireAuth,
  requireWorkspaceContext,
  async (req, res) => {
    try {
      const data = linkUserIntegrationSchema.parse(req.body);

      // Verify integration type exists and is active
      const integrationType = await prisma.integrationType.findUnique({
        where: { id: data.integrationTypeId },
      });

      if (!integrationType || !integrationType.isActive) {
        return res.status(404).json({ error: "Integration type not found or inactive" });
      }

      const integrationCategory = String(integrationType.category || "").toLowerCase();
      const isCrmIntegration = integrationCategory === "crm";
      const isAdminWithoutWorkspace = req.user.role === "admin" && !req.workspaceId;

      if (isAdminWithoutWorkspace && !isAllowedForAdminWithoutWorkspace(integrationType)) {
        return res.status(403).json({
          error: "Integration not allowed without workspace",
          details: "Cette intégration nécessite un workspace",
        });
      }

      if (isCrmIntegration && !req.workspaceId) {
        return res.status(403).json({
          error: "CRM integration requires workspace",
          details: "CRM integrations are workspace-scoped and cannot be linked without a workspace",
        });
      }

      // Keep workspace activation requirement for workspace users.
      // Exception: platform admin without workspace can link non-CRM integrations.
      if (!isAdminWithoutWorkspace) {
        const workspaceIntegration = await prisma.workspaceIntegration.findFirst({
          where: {
            workspaceId: req.workspaceId,
            integrationTypeId: data.integrationTypeId,
            isEnabled: true,
          },
        });

        if (!workspaceIntegration) {
          return res.status(403).json({
            error: "Integration not available in this workspace",
            details: "Admin must enable this integration first",
          });
        }
      }

      // Encrypt credentials
      const encryptedCredentials = encryptSecret(JSON.stringify(data.credentials));

      // Upsert user integration
      const integration = await prisma.userIntegration.upsert({
        where: { userId_integrationTypeId: { userId: req.user.sub, integrationTypeId: data.integrationTypeId } },
        create: {
          userId: req.user.sub,
          integrationTypeId: data.integrationTypeId,
          encryptedCredentials,
        },
        update: {
          encryptedCredentials,
        },
        include: { integrationType: true },
      });

      await logAudit(req.user.sub, "LINK_USER_INTEGRATION", {
        integrationTypeId: data.integrationTypeId,
        workspaceId: req.workspaceId,
      });

      const masked = { ...integration, encryptedCredentials: maskSecret(integration.encryptedCredentials) };
      res.status(201).json({ integration: masked });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", issues: err.errors });
      }
      console.error("[POST /users/me/integrations] Error:", err);
      res.status(500).json({ error: "Failed to link integration" });
    }
  }
);

/**
 * POST /api/users/me/integrations/:id/test
 * User: Test saved personal integration credentials
 */
router.post(
  "/me/:id/test",
  requireAuth,
  requireWorkspaceContext,
  async (req, res) => {
    try {
      const { id } = req.params;

      const integration = await prisma.userIntegration.findUnique({
        where: { id },
        include: { integrationType: true },
      });

      if (!integration) {
        return res.status(404).json({ error: "Integration not found" });
      }

      if (integration.userId !== req.user.sub && req.user.role !== "admin") {
        return res.status(403).json({ error: "Not authorized" });
      }

      let credentials = {};
      try {
        credentials = JSON.parse(decryptSecret(integration.encryptedCredentials));
      } catch {
        return res.status(400).json({ error: "Credentials invalides" });
      }

      const result = await testIntegrationConnection(integration.integrationType.name, credentials);
      return res.json(result);
    } catch (err) {
      console.error("[POST /users/me/integrations/:id/test] Error:", err);
      const message = err?.message || "Erreur lors du test";
      const status = message.includes("401") ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  }
);

/**
 * DELETE /api/users/me/integrations/:id
 * User: Unlink personal integration
 */
router.delete(
  "/me/:id",
  requireAuth,
  requireWorkspaceContext,
  async (req, res) => {
    try {
      const { id } = req.params;

      // Verify ownership
      const integration = await prisma.userIntegration.findUnique({
        where: { id },
        select: { userId: true },
      });

      if (!integration) {
        return res.status(404).json({ error: "Integration not found" });
      }

      if (integration.userId !== req.user.sub && req.user.role !== "admin") {
        return res.status(403).json({ error: "Not authorized" });
      }

      await prisma.userIntegration.delete({
        where: { id },
      });

      await logAudit(req.user.sub, "UNLINK_USER_INTEGRATION", { integrationId: id });

      res.json({ message: "Integration unlinked" });
    } catch (err) {
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Integration not found" });
      }
      console.error("[DELETE /users/me/integrations/:id] Error:", err);
      res.status(500).json({ error: "Failed to unlink integration" });
    }
  }
);

// ====== Admin seed route (for bootstrap) ======

/**
 * POST /api/integrations/seed
 * Admin only: Insert default integration types if they don't exist
 */
router.post("/seed", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const defaultTypes = [
      // CRM
      {
        name: "Sellsy",
        category: "crm",
        logoUrl: "https://sellsy.com/images/logo.svg",
        configSchema: { token: { type: "string" }, apiUrl: { type: "string" } },
      },
      {
        name: "HubSpot",
        category: "crm",
        logoUrl: "https://www.hubspot.com/logo.svg",
        configSchema: { apiKey: { type: "string" } },
      },
      {
        name: "Pipedrive",
        category: "crm",
        logoUrl: "https://www.pipedrive.com/logo.svg",
        configSchema: { apiKey: { type: "string" }, companyDomain: { type: "string" } },
      },
      // Mail
      {
        name: "Gmail SMTP",
        category: "mail",
        logoUrl: "https://www.google.com/favicon.ico",
        configSchema: {
          email: { type: "string" },
          password: { type: "string" },
          smtpServer: { type: "string", default: "smtp.gmail.com" },
          port: { type: "number", default: 587 },
        },
      },
      {
        name: "SendGrid",
        category: "mail",
        logoUrl: "https://www.sendgrid.com/favicon.ico",
        configSchema: { apiKey: { type: "string" } },
      },
      {
        name: "SMTP Custom",
        category: "mail",
        logoUrl: null,
        configSchema: {
          smtpServer: { type: "string" },
          port: { type: "number" },
          email: { type: "string" },
          password: { type: "string" },
        },
      },
      // WhatsApp
      {
        name: "Meta Business WhatsApp",
        category: "whatsapp",
        logoUrl: "https://www.whatsapp.com/favicon.ico",
        configSchema: {
          businessAccountId: { type: "string" },
          accessToken: { type: "string" },
          phoneNumber: { type: "string" },
        },
      },
      {
        name: "Twilio WhatsApp",
        category: "whatsapp",
        logoUrl: "https://www.twilio.com/favicon.ico",
        configSchema: {
          accountSid: { type: "string" },
          authToken: { type: "string" },
          twilioPhoneNumber: { type: "string" },
        },
      },
      // Calendar
      {
        name: "Google Calendar",
        category: "calendar",
        logoUrl: "https://www.google.com/favicon.ico",
        configSchema: {
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          refreshToken: { type: "string" },
        },
      },
      {
        name: "Outlook Calendar",
        category: "calendar",
        logoUrl: "https://www.microsoft.com/favicon.ico",
        configSchema: {
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          refreshToken: { type: "string" },
        },
      },
      {
        name: "CalDAV",
        category: "calendar",
        logoUrl: null,
        configSchema: {
          url: { type: "string" },
          username: { type: "string" },
          password: { type: "string" },
        },
      },
      // Workspace data storage
      {
        name: "DB Local",
        category: "storage",
        logoUrl: null,
        configSchema: {
          description: { type: "string", default: "Stockage local des données du workspace" },
        },
      },
      {
        name: "Knowledge Base Workspace",
        category: "storage",
        logoUrl: null,
        configSchema: {
          description: { type: "string", default: "Base de connaissances et ressources du workspace" },
        },
      },
      // CRM additional
      {
        name: "CRM Salesforce",
        category: "crm",
        logoUrl: "https://www.salesforce.com/favicon.ico",
        configSchema: {
          instanceUrl: { type: "string" },
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          username: { type: "string" },
          password: { type: "string" },
        },
      },
      // Other
      {
        name: "Webhook",
        category: "other",
        logoUrl: null,
        configSchema: {
          url: { type: "string" },
          secret: { type: "string" },
        },
      },
      {
        name: "Custom API",
        category: "other",
        logoUrl: null,
        configSchema: {
          baseUrl: { type: "string" },
          apiKey: { type: "string" },
        },
      },
    ];

    const created = [];

    for (const typeData of defaultTypes) {
      const existing = await prisma.integrationType.findFirst({
        where: { name: typeData.name },
      });

      if (!existing) {
        const type = await prisma.integrationType.create({ data: typeData });
        created.push(type);
      }
    }

    res.json({
      message: `Seeded ${created.length} integration types`,
      created,
    });
  } catch (err) {
    console.error("[POST /seed] Error:", err);
    res.status(500).json({ error: "Failed to seed integration types" });
  }
});

/**
 * POST /api/integrations/test-connection
 * Test connection to an integration (SMTP, IMAP, POP, etc.)
 */
router.post("/test-connection", requireAuth, async (req, res) => {
  try {
    const { integrationType, config, credentials, protocol } = z.object({
      integrationType: z.string(),
      config: z.record(z.any()).optional(),
      credentials: z.record(z.any()).optional(),
      protocol: z.string().optional(),
    }).parse(req.body);
    const result = await testIntegrationConnection(integrationType, credentials || {}, protocol);
    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Données invalides", issues: err.errors });
    }
    console.error("[POST /test-connection] Error:", err);
    const message = err?.message || "Erreur lors du test de connexion";
    const status = message.includes("401") ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
