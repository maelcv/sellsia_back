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
    WHERE u.tenant_id = $1
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
    const parent = await prisma.tenant.findUnique({
      where: { id: currentTenantId },
      select: { parentTenantId: true }
    });
    currentTenantId = parent?.parentTenantId || null;
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

  // 2) Cascade tenant hiérarchique : tenant du user → parent tenant(s) → ...
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true }
  });

  if (user?.tenantId) {
    const tenantProvider = await getProviderForTenant(user.tenantId);
    if (tenantProvider) return tenantProvider;
  }

  // 3) Provider global actif configuré par l'admin (ExternalService)
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

  // 4) Backward compatibility: service IA admin user (client_service_links de l'admin)
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
 * @param {number} userId
 * @returns {Promise<{ token: string, type: 'token'|'oauth' } | null>}
 */
export async function getSellsyCredentials(userId) {
  const links = await prisma.$queryRaw`
    SELECT csl.api_key_encrypted, csl.api_secret_encrypted, es.code
    FROM client_service_links csl
    JOIN external_services es ON es.id = csl.service_id
    WHERE csl.owner_user_id = ${userId}
      AND csl.status = 'active'
      AND es.code IN ('sellsy-token', 'sellsy-oauth')
      AND es.is_active = true
    LIMIT 1
  `;

  const link = links[0] || null;

  if (!link) return null;

  if (link.code === "sellsy-token") {
    const token = link.api_key_encrypted ? decryptSecret(link.api_key_encrypted) : "";
    return token ? { token, type: "token" } : null;
  }

  if (link.code === "sellsy-oauth") {
    const clientId = link.api_key_encrypted ? decryptSecret(link.api_key_encrypted) : "";
    const clientSecret = link.api_secret_encrypted ? decryptSecret(link.api_secret_encrypted) : "";
    return clientId && clientSecret ? { clientId, clientSecret, type: "oauth" } : null;
  }

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
