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
 * Récupère le provider LLM actif pour un client (userId).
 * Cherche d'abord un service IA configuré par l'utilisateur.
 * Si l'utilisateur n'en a pas, utilise le provider de l'admin en fallback.
 * @param {number} userId - ID de l'utilisateur/client
 * @returns {Promise<BaseLLMProvider|null>}
 */
export async function getProviderForUser(userId) {
  // 1) Provider global actif configure par l'admin (source principale)
  const globalProviders = await prisma.$queryRaw`
    SELECT es.code, es.default_config as "defaultConfig"
    FROM external_services es
    WHERE es.category IN ('ia_cloud', 'ia_local')
      AND es.is_active = true
    ORDER BY es.id ASC
    LIMIT 1
  `;

  const globalProvider = globalProviders[0] || null;

  if (globalProvider) {
    const provider = instantiateProviderFromExternalService(globalProvider);
    if (provider) return provider;
  }

  // 2) Backward compatibility: service IA actif configure au niveau utilisateur
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

  let link = userLinks[0] || null;

  // Si l'utilisateur n'a pas de provider, fallback au provider de l'admin
  if (!link) {
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
    link = adminLinks[0] || null;
  }

  if (!link) return null;

  return instantiateProvider(link);
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
