/**
 * Redis Client — Connexion unique avec fallback gracieux.
 *
 * Si REDIS_URL n'est pas défini ou si Redis est indisponible,
 * toutes les opérations retournent null/undefined sans planter.
 * Le reste de l'application fonctionne normalement (juste sans cache).
 */

let _client = null;
let _unavailable = false;

/**
 * Retourne le client Redis connecté, ou null si indisponible.
 * @returns {Promise<import("ioredis").Redis|null>}
 */
export async function getRedis() {
  if (_unavailable) return null;
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    await client.connect();

    client.on("error", (err) => {
      if (!_unavailable) {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "redis.error",
          error: err.message,
          ts: Date.now(),
        }));
      }
      _unavailable = true;
      _client = null;
    });

    client.on("connect", () => {
      _unavailable = false;
    });

    _client = client;
    return client;
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "redis.unavailable",
      error: err.message,
      ts: Date.now(),
    }));
    _unavailable = true;
    return null;
  }
}

/**
 * Réinitialise l'état pour les tests.
 */
export function resetRedisClient() {
  _client = null;
  _unavailable = false;
}
