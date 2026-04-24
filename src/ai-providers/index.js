/**
 * Provider Factory — Résout le bon provider LLM pour un client donné.
 * Lit les credentials chiffrées en base et instancie le provider approprié.
 */

import { prisma } from "../prisma.js";
import { decryptSecret } from "../security/secrets.js";
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

const PROVIDER_CODE_BY_NAME = {
  openai: "openai-cloud",
  anthropic: "anthropic-cloud",
  mistral: "mistral-cloud",
  openrouter: "openrouter-cloud",
  ollama: "ollama-local",
  "lm studio": "lmstudio-local",
  lmstudio: "lmstudio-local",
};

function normalizeRole(role) {
  const value = String(role || "").trim();
  if (value === "admin" || value === "admin_platform") return "admin_platform";
  if (value === "client" || value === "workspace_manager") return "workspace_manager";
  if (value === "sub_client" || value === "workspace_user") return "workspace_user";
  return value;
}

function isAdminRole(role) {
  return normalizeRole(role) === "admin_platform";
}

function isManagerRole(role) {
  return normalizeRole(role) === "workspace_manager";
}

function parseJsonSafe(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return parsed;
    return fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeModels(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const models = [];
  for (const raw of input) {
    const model = String(raw || "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function resolveDefaultModel(code, payload = {}) {
  const explicitModel = String(payload?.model || "").trim();
  if (explicitModel) return explicitModel;

  const models = normalizeModels(payload?.models);
  if (models.length > 0) return models[0];

  return DEFAULT_MODELS[code];
}

function inferProviderCodeFromName(name) {
  const normalizedName = String(name || "").toLowerCase();
  for (const [token, code] of Object.entries(PROVIDER_CODE_BY_NAME)) {
    if (normalizedName.includes(token)) return code;
  }
  return "";
}

function decodeEncryptedJson(payload) {
  if (!payload) return {};
  try {
    return parseJsonSafe(decryptSecret(payload), {});
  } catch {
    return {};
  }
}

function extractProviderConfigFromWorkspaceIntegrationRow(row) {
  const decrypted = decodeEncryptedJson(row?.encrypted_config);
  const code = String(decrypted.code || inferProviderCodeFromName(row?.integration_name) || "").trim();
  if (!code || !PROVIDER_MAP[code]) return null;

  const apiKey = String(
    decrypted.apiKey ||
    decrypted.api_key ||
    decrypted.token ||
    ""
  ).trim();

  return {
    code,
    apiKey,
    model: resolveDefaultModel(code, decrypted),
    models: normalizeModels(decrypted.models),
    baseUrl: decrypted.baseUrl || BASE_URLS[code] || undefined,
    host: decrypted.host || undefined,
  };
}

function instantiateProviderFromConfig(providerConfig) {
  if (!providerConfig?.code) return null;
  const ProviderClass = PROVIDER_MAP[providerConfig.code];
  if (!ProviderClass) return null;

  return new ProviderClass({
    apiKey: providerConfig.apiKey || "",
    defaultModel: resolveDefaultModel(providerConfig.code, providerConfig),
    baseUrl: providerConfig.baseUrl || BASE_URLS[providerConfig.code] || undefined,
    host: providerConfig.host || undefined,
  });
}

async function getSystemDefaultProviderConfig() {
  const row = await prisma.systemSetting.findUnique({
    where: { key: "default_ai_provider" },
    select: { value: true },
  });

  if (!row?.value) return null;

  const parsed = parseJsonSafe(row.value, null);
  if (!parsed) return null;

  const code = String(parsed.code || "").trim();
  if (!code || !PROVIDER_MAP[code]) return null;

  let apiKey = "";
  if (parsed.apiKeyEncrypted) {
    try {
      apiKey = decryptSecret(parsed.apiKeyEncrypted);
    } catch {
      apiKey = "";
    }
  } else if (parsed.apiKey) {
    apiKey = String(parsed.apiKey);
  }

  return {
    code,
    apiKey,
    model: resolveDefaultModel(code, parsed),
    models: normalizeModels(parsed.models),
    baseUrl: parsed.baseUrl || BASE_URLS[code] || undefined,
    host: parsed.host || undefined,
  };
}

async function listWorkspaceAiProviderRows(workspaceId) {
  if (!workspaceId) return [];

  const rows = await prisma.$queryRaw`
    SELECT
      wi.id,
      wi.workspace_id,
      wi.encrypted_config,
      wi.access_mode,
      wi.allowed_role_ids,
      wi.allowed_user_ids,
      it.name as integration_name
    FROM workspace_integrations wi
    JOIN integration_types it ON it.id = wi.integration_type_id
    WHERE wi.workspace_id = ${workspaceId}
      AND wi.is_enabled = true
      AND it.is_active = true
      AND it.category = 'ai_provider'
    ORDER BY wi.configured_at DESC
  `;

  return Array.isArray(rows) ? rows : [];
}

async function isWorkspaceProviderAccessible(row, userId, workspaceRole, roleIdsInWorkspace) {
  if (isAdminRole(workspaceRole) || isManagerRole(workspaceRole)) return true;

  const mode = String(row?.access_mode || "workspace").toLowerCase();
  if (mode !== "restricted") return true;

  const allowedUserIds = parseJsonArray(row?.allowed_user_ids)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (allowedUserIds.includes(Number(userId))) {
    return true;
  }

  const allowedRoleIds = parseJsonArray(row?.allowed_role_ids)
    .map((value) => String(value).trim())
    .filter(Boolean);

  if (allowedRoleIds.length === 0) return false;

  return allowedRoleIds.some((roleId) => roleIdsInWorkspace.has(roleId));
}

async function getAccessibleWorkspaceProviderConfig({ workspaceId, userId, userRole }) {
  const rows = await listWorkspaceAiProviderRows(workspaceId);
  if (rows.length === 0) return null;

  const normalizedRole = normalizeRole(userRole);

  let roleIds = new Set();
  if (!isAdminRole(normalizedRole) && !isManagerRole(normalizedRole)) {
    const assignments = await prisma.userRoleAssignment.findMany({
      where: {
        userId,
        role: { workspaceId },
      },
      select: { roleId: true },
    });
    roleIds = new Set(assignments.map((assignment) => assignment.roleId));
  }

  for (const row of rows) {
    const accessible = await isWorkspaceProviderAccessible(row, userId, normalizedRole, roleIds);
    if (!accessible) continue;

    const providerConfig = extractProviderConfigFromWorkspaceIntegrationRow(row);
    if (providerConfig) return providerConfig;
  }

  return null;
}

function instantiateProvider(link) {
  const ProviderClass = PROVIDER_MAP[link.code];
  if (!ProviderClass) return null;

  let apiKey = "";
  if (link.api_key_encrypted) {
    try { apiKey = decryptSecret(link.api_key_encrypted); } catch {
      console.warn(`[ai-providers] decrypt failed for provider ${link.code} — key may need to be re-saved`);
      return null;
    }
  }
  const cfg = JSON.parse(link.config_json || "{}");

  return new ProviderClass({
    apiKey,
    defaultModel: resolveDefaultModel(link.code, cfg),
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
    try { apiKey = decryptSecret(cfg.apiKey); } catch {
      console.warn(`[ai-providers] decrypt failed for external service ${row.code} — key needs to be re-saved`);
      return null;
    }
  } else if (cfg.apiKey) {
    apiKey = cfg.apiKey;
  }

  return new ProviderClass({
    apiKey,
    defaultModel: resolveDefaultModel(row.code, cfg),
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
  if (!tenantId) {
    const systemDefault = await getSystemDefaultProviderConfig();
    const provider = instantiateProviderFromConfig(systemDefault);
    return provider || null;
  }

  let currentTenantId = tenantId;
  const IA_PROVIDER_SQL = `
    SELECT csl.api_key_encrypted, csl.api_secret_encrypted, csl.config_json,
           es.code, es.category
    FROM client_service_links csl
    JOIN external_services es ON es.id = csl.service_id
    JOIN users u ON u.id = csl.owner_user_id
    WHERE u.workspace_id = $1
      AND u.role IN ('client', 'workspace_manager')
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

    const workspaceProviderConfig = await getAccessibleWorkspaceProviderConfig({
      workspaceId: currentTenantId,
      userId: 0,
      userRole: "workspace_manager",
    });
    const workspaceProvider = instantiateProviderFromConfig(workspaceProviderConfig);
    if (workspaceProvider) {
      return workspaceProvider;
    }

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

  const systemDefaultProvider = instantiateProviderFromConfig(await getSystemDefaultProviderConfig());
  if (systemDefaultProvider) {
    return systemDefaultProvider;
  }

  // Fallback : provider global configuré par l'admin (ExternalService)
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

  return null;
}

/**
 * Récupère le provider LLM actif pour un client (userId).
 * Cascade : user → tenant → tenant parent(s) → global admin ExternalService → admin user service
 * @param {number} userId - ID de l'utilisateur/client
 * @returns {Promise<BaseLLMProvider|null>}
 */
export async function getProviderForUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, workspaceId: true },
  });

  // 1) Workspace integrations (new model) with parent fallback
  let currentWorkspaceId = user?.workspaceId || null;
  for (let depth = 0; depth < 3; depth++) {
    if (!currentWorkspaceId) break;

    const workspaceProviderConfig = await getAccessibleWorkspaceProviderConfig({
      workspaceId: currentWorkspaceId,
      userId,
      userRole: user?.role,
    });
    const workspaceProvider = instantiateProviderFromConfig(workspaceProviderConfig);
    if (workspaceProvider) {
      return workspaceProvider;
    }

    const parent = await prisma.workspace.findUnique({
      where: { id: currentWorkspaceId },
      select: { parentWorkspaceId: true },
    });
    currentWorkspaceId = parent?.parentWorkspaceId || null;
  }

  // 2) Service IA actif configure au niveau utilisateur (legacy override direct)
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

  // 3) Default provider configured in system settings
  const systemDefaultProvider = instantiateProviderFromConfig(await getSystemDefaultProviderConfig());
  if (systemDefaultProvider) {
    return systemDefaultProvider;
  }

  // 4) Provider global actif configuré par l'admin (ExternalService)
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

  // 5) Backward compatibility: service IA admin user (client_service_links de l'admin)
  const adminLinks = await prisma.$queryRawUnsafe(
    `SELECT csl.api_key_encrypted, csl.api_secret_encrypted, csl.config_json,
            es.code, es.category
     FROM client_service_links csl
     JOIN external_services es ON es.id = csl.service_id
     JOIN users u ON u.id = csl.owner_user_id
     WHERE u.role IN ('admin', 'admin_platform')
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
        AND u.role IN ('client', 'sub_client', 'workspace_manager', 'workspace_user')
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
        AND u.role IN ('client', 'sub_client', 'workspace_manager', 'workspace_user')
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
  // 1) Platform default provider stored in system settings
  const systemDefault = await getSystemDefaultProviderConfig();
  if (systemDefault?.code) {
    return systemDefault.code;
  }

  // 2) Workspace integration provider (new model)
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, workspaceId: true },
    });

    let currentWorkspaceId = user?.workspaceId || null;
    for (let depth = 0; depth < 3; depth++) {
      if (!currentWorkspaceId) break;

      const workspaceConfig = await getAccessibleWorkspaceProviderConfig({
        workspaceId: currentWorkspaceId,
        userId,
        userRole: user?.role,
      });

      if (workspaceConfig?.code) {
        return workspaceConfig.code;
      }

      const parent = await prisma.workspace.findUnique({
        where: { id: currentWorkspaceId },
        select: { parentWorkspaceId: true },
      });
      currentWorkspaceId = parent?.parentWorkspaceId || null;
    }
  }

  // 3) Provider global actif configure par l'admin (legacy external_services)
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

  // 4) Si userId fourni, chercher provider utilisateur legacy
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

    // 5) Fallback au provider legacy de l'admin
    const adminProviders = await prisma.$queryRaw`
      SELECT es.code
      FROM client_service_links csl
      JOIN external_services es ON es.id = csl.service_id
      JOIN users u ON u.id = csl.owner_user_id
      WHERE u.role IN ('admin', 'admin_platform')
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
