import { z } from "../types.js";

// ─── Protection SSRF ─────────────────────────────────────────────────────────

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\.0\.0\.0/,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "169.254.169.254"]);

function validateUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`URL invalide: ${urlStr}`);
  }

  const { protocol, hostname } = parsed;

  if (!["http:", "https:"].includes(protocol)) {
    throw new Error(`Protocole non autorisé: ${protocol}`);
  }

  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error(`Hôte bloqué (SSRF): ${hostname}`);
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(`IP privée bloquée (SSRF): ${hostname}`);
    }
  }
}

// ─── Brick ────────────────────────────────────────────────────────────────────

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024; // 1 MB
const TIMEOUT_MS = 10_000;

export const httpRequestAction = {
  id: "action:http_request",
  category: "action",
  name: "Requête HTTP",
  description: "Envoie une requête HTTP vers une URL externe et récupère la réponse.",
  icon: "Globe",
  color: "#3498db",

  inputSchema: z.object({
    url:     z.string().describe("URL cible (HTTPS recommandé)"),
    method:  z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("Méthode HTTP"),
    headers: z.record(z.string()).optional().describe("En-têtes HTTP (JSON)"),
    body:    z.any().optional().describe("Corps de la requête (JSON)"),
  }),

  outputSchema: z.object({
    status:  z.number().describe("Code de statut HTTP"),
    data:    z.any().describe("Corps de la réponse (JSON ou texte)"),
    headers: z.any().describe("En-têtes de la réponse"),
  }),

  async execute(inputs, context) {
    const { url, method = "POST", headers = {}, body } = inputs;

    if (!url) throw new Error("url est requis");
    if (!ALLOWED_METHODS.includes(method.toUpperCase())) {
      throw new Error(`Méthode non autorisée: ${method}`);
    }

    validateUrl(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // Lire avec limite de taille
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("Réponse trop grande (> 1 MB)");
      }

      let data;
      try { data = JSON.parse(text); } catch { data = text; }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
      }

      const responseHeaders = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });

      return { status: res.status, data, headers: responseHeaders };
    } finally {
      clearTimeout(timeout);
    }
  },
};
