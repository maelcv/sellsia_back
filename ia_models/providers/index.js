/**
 * Provider Factory — Résout le bon provider LLM pour un client donné.
 * Lit les credentials chiffrées en base et instancie le provider approprié.
 */

import { prisma } from "../../src/prisma.js";
import { decryptSecret } from "../../src/security/secrets.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { MistralProvider } from "./mistral.js";
import { OllamaProvider } from "./ollama.js";

const PROVIDER_MAP = {
  "openai-cloud": OpenAIProvider,
  "anthropic-cloud": AnthropicProvider,
  "mistral-cloud": MistralProvider,
  "ollama-local": OllamaProvider,
  "openrouter-cloud": OpenAIProvider, // OpenRouter utilise l'API OpenAI
  "lmstudio-local": OpenAIProvider // LM Studio utilise l'API OpenAI
};

const DEFAULT_MODELS = {
  "openai-cloud": "gpt-4o-mini",
  "anthropic-cloud": "claude-sonnet-4-20250514",
  "mistral-cloud": "mistral-small-latest",
  "ollama-local": "llama3.1",
  "openrouter-cloud": "openai/gpt-4o-mini",
  "lmstudio-local": "default"
};

const BASE_URLS = {
  "openrouter-cloud": "https://openrouter.ai/api/v1",
  "lmstudio-local": "http://localhost:1234/v1"
};

function instantiateProvider(link) {
  const ProviderClass = PROVIDER_MAP[link.code];
  if (!ProviderClass) return null;

  const apiKey = link.api_key_encrypted ? decryptSecret(link.api_key_encrypted) : "";
  const cfg = JSON.parse(link.config_json || "{}");

  return new ProviderClass({
    apiKey,
    defaultModel: cfg.model || DEFAULT_MODELS[link.code],
    baseUrl: cfg.baseUrl || BASE_URLS[link.code] || undefined,
    host: cfg.host || undefined
  });
}

function instantiateProviderFromExternalService(row) {
  const ProviderClass = PROVIDER_MAP[row.code];
  if (!ProviderClass) return null;

  const cfg = JSON.parse(row.defaultConfig || "{}");

  // ── Decrypt encrypted API key if present ──
  let apiKey = "";
  if (cfg._apiKeyEncrypted && cfg.apiKey) {
    apiKey = decryptSecret(cfg.apiKey);
  } else if (cfg.apiKey) {
    apiKey = cfg.apiKey;
  }

  return new ProviderClass({
    apiKey,
    defaultModel: cfg.model || DEFAULT_MODELS[row.code],
    baseUrl: cfg.baseUrl || BASE_URLS[row.code] || undefined,
    host: cfg.host || undefined
  });
}

/**
 * Cherche un provider IA actif dans un tenant donné (owner user du tenant).
 * Remonte la chaîne parentale (max 3 niveaux) si aucun n'est trouvé.
 * @param {string} tenantId
 * @returns {Promise<BaseLLMProvider|null>}
 */
export async function getProviderForTenant(tenantId) {
  if (!tenantId) return null;

  let currentTenantId = tenantId;
  const IA_PROVIDER_SQL = `
    SELECT csl.api_key_encrypted, csl.api_secret_encrypted, csl.config_json,
           es.code, es.category
    FROM client_service_links csl
    JOIN external_services es ON es.id = csl.service_id
    JOIN users u ON u.id = csl.owner_user_id
    WHERE u.workspace_id = $1
      AND u.role = 'client'
      AND csl.status = 'active'
      AND es.category IN ('ia_cloud', 'ia_local')
      AND es.is_active = true
    ORDER BY
      CASE es.code
        WHEN 'anthropic-cloud' THEN 1
        WHEN 'openai-cloud' THEN 2
        WHEN 'mistral-cloud' THEN 3
        WHEN 'openrouter-cloud' THEN 4
        WHEN 'ollama-local' THEN 5
        WHEN 'lmstudio-local' THEN 6
        ELSE 99
      END
    LIMIT 1
  `;

  for (let depth = 0; depth < 3; depth++) {
    if (!currentTenantId) break;

    const links = await prisma.$queryRawUnsafe(IA_PROVIDER_SQL, currentTenantId);
    if (links[0]) {
      return instantiateProvider(links[0]);
    }

    // Remonter vers le parent
    const parent = await prisma.workspace.findUnique({
      where: { id: currentTenantId },
      select: { parentWorkspaceId: true }
    });
    currentTenantId = parent?.parentWorkspaceId || null;
  }

  return null;
}

/**
 * Récupère le provider LLM actif pour un client (userId).
 * Cascade : user → tenant → tenant parent(s) → global admin ExternalService → admin user service
 * @param {number} userId - ID de l'utilisateur/client
 * @returns {Promise<BaseLLMProvider|null>}
 */
export async function getProviderForUser(userId) {
  // 1) Service IA actif configure au niveau utilisateur (override direct)
  const userLinks = await prisma.$queryRawUnsafe(
    `SELECT csl.api_key_encrypted, csl.api_secret_encrypted, csl.config_json,
            es.code, es.category
     FROM client_service_links csl
     JOIN external_services es ON es.id = csl.service_id
     WHERE csl.owner_user_id = $1
       AND csl.status = 'active'
       AND es.category IN ('ia_cloud', 'ia_local')
       AND es.is_active = true
     ORDER BY
       CASE es.code
         WHEN 'anthropic-cloud' THEN 1
         WHEN 'openai-cloud' THEN 2
         WHEN 'mistral-cloud' THEN 3
         WHEN 'openrouter-cloud' THEN 4
         WHEN 'ollama-local' THEN 5
         WHEN 'lmstudio-local' THEN 6
         ELSE 99
       END
     LIMIT 1`,
    userId
  );

  if (userLinks[0]) return instantiateProvider(userLinks[0]);

  // 2) Provider global actif configuré par l'admin (ExternalService)
  const globalProviders = await prisma.$queryRaw`
    SELECT es.code, es.default_config as "defaultConfig"
    FROM external_services es
    WHERE es.category IN ('ia_cloud', 'ia_local')
      AND es.is_active = true
    ORDER BY es.id ASC
    LIMIT 1
  `;

  if (globalProviders[0]) {
    const provider = instantiateProviderFromExternalService(globalProviders[0]);
    if (provider) return provider;
  }

  // 3) Backward compatibility: service IA admin user (client_service_links de l'admin)
  const adminLinks = await prisma.$queryRawUnsafe(
    `SELECT csl.api_key_encrypted, csl.api_secret_encrypted, csl.config_json,
            es.code, es.category
     FROM client_service_links csl
     JOIN external_services es ON es.id = csl.service_id
     JOIN users u ON u.id = csl.owner_user_id
     WHERE u.role = 'admin'
       AND csl.status = 'active'
       AND es.category IN ('ia_cloud', 'ia_local')
       AND es.is_active = true
     ORDER BY
       CASE es.code
         WHEN 'anthropic-cloud' THEN 1
         WHEN 'openai-cloud' THEN 2
         WHEN 'mistral-cloud' THEN 3
         WHEN 'openrouter-cloud' THEN 4
         WHEN 'ollama-local' THEN 5
         WHEN 'lmstudio-local' THEN 6
         ELSE 99
       END
     LIMIT 1`
  );

  if (adminLinks[0]) return instantiateProvider(adminLinks[0]);

  return null;
}

/**
 * Récupère les credentials Sellsy actives pour un client.
 * Priorité : 
 * 1. UserIntegration (personnel)
 * 2. ClientServiceLink (legacy user)
 * 3. Cascade Workspace UserIntegration
 * 4. Cascade Workspace ClientServiceLink
 * 
 * @param {number} userId
 * @returns {Promise<{ token: string, type: 'token'|'oauth' } | { clientId: string, clientSecret: string, type: 'oauth' } | null>}
 */
export async function getSellsyCredentials(userId) {
  // Helper: extract token or OAuth credentials from a decrypted credentials object.
  // Supports multiple field name conventions used by different frontend versions.
  function extractCreds(creds) {
    const token = creds.token || creds.apiToken || creds.api_token || creds.apiKey || creds.api_key;
    const key = creds.key || creds.apiSecret || creds.api_secret;
    const clientId = creds.clientId || creds.client_id;
    const clientSecret = creds.clientSecret || creds.client_secret || creds.clientKey || creds.client_key;

    const refreshToken = creds.refreshToken || creds.refresh_token;
    const accessToken = creds.accessToken || creds.access_token;

    // Prefer OAuth bundle when available, otherwise OAuth cannot refresh and will fail silently later.
    if (clientId && clientSecret && (refreshToken || accessToken)) {
      return {
        type: "oauth",
        clientId,
        clientSecret,
        ...(refreshToken && { refreshToken }),
        ...(accessToken && { accessToken }),
      };
    }

    // Legacy "Token + Key" mode can behave like OAuth client credentials.
    if (token && key) {
      return {
        type: "oauth",
        clientId: token,
        clientSecret: key,
      };
    }

    const plainToken = token || accessToken;
    if (plainToken) return { token: plainToken, type: "token" };

    // Last resort: OAuth client credentials alone (legacy setup).
    if (clientId && clientSecret) return { clientId, clientSecret, type: "oauth" };
    return null;
  }

  // 1. User's own Sellsy credentials (Modern - UserIntegration)
  // Uses ILIKE for case-insensitive name matching and LIKE '%sellsy%' for partial match
  // to tolerate naming variations ('Sellsy', 'Sellsy CRM', 'sellsy', etc.)
  const userIntegrations = await prisma.$queryRaw`
    SELECT ui.encrypted_credentials, it.name
    FROM user_integrations ui
    JOIN integration_types it ON it.id = ui.integration_type_id
    WHERE ui.user_id = ${userId}
      AND LOWER(it.name) LIKE '%sellsy%'
      AND it.category = 'crm'
    ORDER BY ui.linked_at DESC
    LIMIT 1
  `;

  if (userIntegrations[0]) {
    try {
      const creds = JSON.parse(decryptSecret(userIntegrations[0].encrypted_credentials));
      const result = extractCreds(creds);
      if (result) {
        console.log(`[getSellsyCredentials] Found UserIntegration for user ${userId} (type: ${result.type})`);
        return result;
      }
      console.warn("[getSellsyCredentials] UserIntegration found but no usable credential fields:", Object.keys(creds));
    } catch (e) {
      console.error("[getSellsyCredentials] Failed to parse UserIntegration:", e.message);
    }
  }

  // 2. User's own Sellsy credentials (Legacy - ClientServiceLink)
  const legacyLinks = await prisma.$queryRaw`
    SELECT csl.api_key_encrypted, csl.api_secret_encrypted, es.code
    FROM client_service_links csl
    JOIN external_services es ON es.id = csl.service_id
    WHERE csl.owner_user_id = ${userId}
      AND csl.status = 'active'
      AND es.code IN ('sellsy-token', 'sellsy-oauth')
      AND es.is_active = true
    LIMIT 1
  `;

  if (legacyLinks[0]) {
    const link = legacyLinks[0];
    if (link.code === "sellsy-token") {
      const token = link.api_key_encrypted ? decryptSecret(link.api_key_encrypted) : "";
      if (token) return { token, type: "token" };
    }
    if (link.code === "sellsy-oauth") {
      const clientId = link.api_key_encrypted ? decryptSecret(link.api_key_encrypted) : "";
      const clientSecret = link.api_secret_encrypted ? decryptSecret(link.api_secret_encrypted) : "";
      if (clientId && clientSecret) return { clientId, clientSecret, type: "oauth" };
    }
  }

  // 3. Cascade to Workspace Level
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { workspaceId: true }
  });

  if (user?.workspaceId) {
    // 3a. Workspace-wide Integration (Modern - WorkspaceIntegration)
    // The workspace config typically holds shared settings (webhook, apiUrl).
    // It may also contain actual credentials — try to extract them if present.
    const workspaceIntegrations = await prisma.$queryRaw`
      SELECT wi.encrypted_config, it.name
      FROM workspace_integrations wi
      JOIN integration_types it ON it.id = wi.integration_type_id
      WHERE wi.workspace_id = ${user.workspaceId}
        AND LOWER(it.name) LIKE '%sellsy%'
        AND it.category = 'crm'
        AND wi.is_enabled = true
      LIMIT 1
    `;

    if (workspaceIntegrations[0]) {
      try {
        const creds = JSON.parse(decryptSecret(workspaceIntegrations[0].encrypted_config));
        const result = extractCreds(creds);
        if (result) {
          console.log(`[getSellsyCredentials] Found WorkspaceIntegration for workspace ${user.workspaceId} (type: ${result.type})`);
          return result;
        }
        // WorkspaceIntegration may only hold shared config (no actual credentials) — fall through
      } catch (e) {
        console.error("[getSellsyCredentials] Failed to parse WorkspaceIntegration:", e.message);
      }
    }

    // 3b. Workspace UserIntegration (any client or sub-client in the workspace)
    // Prefers client over sub_client, most recent connection first.
    const wsUserIntegrations = await prisma.$queryRaw`
      SELECT ui.encrypted_credentials, it.name
      FROM user_integrations ui
      JOIN integration_types it ON it.id = ui.integration_type_id
      JOIN users u ON u.id = ui.user_id
      WHERE u.workspace_id = ${user.workspaceId}
        AND LOWER(it.name) LIKE '%sellsy%'
        AND it.category = 'crm'
        AND u.role IN ('client', 'sub_client')
      ORDER BY u.role ASC, ui.linked_at DESC
      LIMIT 1
    `;

    if (wsUserIntegrations[0]) {
      try {
        const creds = JSON.parse(decryptSecret(wsUserIntegrations[0].encrypted_credentials));
        const result = extractCreds(creds);
        if (result) {
          console.log(`[getSellsyCredentials] Found workspace UserIntegration for workspace ${user.workspaceId} (type: ${result.type})`);
          return result;
        }
        console.warn("[getSellsyCredentials] WS UserIntegration found but no usable credential fields:", Object.keys(creds));
      } catch (e) {
        console.error("[getSellsyCredentials] Failed to parse WS UserIntegration:", e.message);
      }
    }

    // 3c. Workspace legacy links
    const wsLegacyLinks = await prisma.$queryRaw`
      SELECT csl.api_key_encrypted, csl.api_secret_encrypted, es.code
      FROM client_service_links csl
      JOIN external_services es ON es.id = csl.service_id
      JOIN users u ON u.id = csl.owner_user_id
      WHERE u.workspace_id = ${user.workspaceId}
        AND u.role IN ('client', 'sub_client')
        AND csl.status = 'active'
        AND es.code IN ('sellsy-token', 'sellsy-oauth')
        AND es.is_active = true
      ORDER BY u.role ASC, csl.updated_at DESC
      LIMIT 1
    `;

    if (wsLegacyLinks[0]) {
      const link = wsLegacyLinks[0];
      if (link.code === "sellsy-token") {
        const token = link.api_key_encrypted ? decryptSecret(link.api_key_encrypted) : "";
        if (token) return { token, type: "token" };
      }
      if (link.code === "sellsy-oauth") {
        const clientId = link.api_key_encrypted ? decryptSecret(link.api_key_encrypted) : "";
        const clientSecret = link.api_secret_encrypted ? decryptSecret(link.api_secret_encrypted) : "";
        if (clientId && clientSecret) return { clientId, clientSecret, type: "oauth" };
      }
    }
  }

  console.warn(`[getSellsyCredentials] No Sellsy credentials found for user ${userId} (workspace: ${user?.workspaceId ?? "none"})`);
  return null;
}

/**
 * Récupère le code du provider IA actif (sans instancier le provider).
 * Cherche d'abord un service IA configuré par l'admin (global).
 * Si aucun, cherche un service IA configuré par l'utilisateur.
 * @param {number} userId - ID de l'utilisateur/client (optionnel, pour recherche utilisateur)
 * @returns {Promise<string|null>} Code du provider (ex: "mistral-cloud", "ollama-local") ou null
 */
export async function getActiveProviderCode(userId = null) {
  // 1) Provider global actif configure par l'admin (source principale)
  const globalProviders = await prisma.$queryRaw`
    SELECT es.code
    FROM external_services es
    WHERE es.category IN ('ia_cloud', 'ia_local')
      AND es.is_active = true
    ORDER BY es.id ASC
    LIMIT 1
  `;

  const globalProvider = globalProviders[0] || null;

  if (globalProvider) {
    return globalProvider.code;
  }

  // 2) Si userId fourni, chercher provider utilisateur
  if (userId) {
    const userProviders = await prisma.$queryRawUnsafe(
      `SELECT es.code
       FROM client_service_links csl
       JOIN external_services es ON es.id = csl.service_id
       WHERE csl.owner_user_id = $1
         AND csl.status = 'active'
         AND es.category IN ('ia_cloud', 'ia_local')
         AND es.is_active = true
       ORDER BY
         CASE es.code
           WHEN 'anthropic-cloud' THEN 1
           WHEN 'openai-cloud' THEN 2
           WHEN 'mistral-cloud' THEN 3
           WHEN 'openrouter-cloud' THEN 4
           WHEN 'ollama-local' THEN 5
           WHEN 'lmstudio-local' THEN 6
           ELSE 99
         END
       LIMIT 1`,
      userId
    );

    const userProvider = userProviders[0] || null;

    if (userProvider) {
      return userProvider.code;
    }

    // 3) Fallback au provider de l'admin
    const adminProviders = await prisma.$queryRaw`
      SELECT es.code
      FROM client_service_links csl
      JOIN external_services es ON es.id = csl.service_id
      JOIN users u ON u.id = csl.owner_user_id
      WHERE u.role = 'admin'
        AND csl.status = 'active'
        AND es.category IN ('ia_cloud', 'ia_local')
        AND es.is_active = true
      LIMIT 1
    `;

    const adminProvider = adminProviders[0] || null;

    if (adminProvider) {
      return adminProvider.code;
    }
  }

  return null;
}
