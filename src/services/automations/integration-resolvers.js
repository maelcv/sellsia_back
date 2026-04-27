import nodemailer from "nodemailer";
import { prisma } from "../../prisma.js";
import { config } from "../../config.js";
import { decryptSecret } from "../../security/secrets.js";

const AI_MODELS_BY_PROVIDER = {
  "openai-cloud": ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
  "anthropic-cloud": ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
  "mistral-cloud": ["mistral-large-latest", "mistral-small-latest"],
  "openrouter-cloud": ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001"],
  "ollama-local": ["llama3.1", "mistral", "qwen2.5"],
  "lmstudio-local": ["default"],
};

const IA_SERVICE_CATEGORIES = ["ia_cloud", "ia_local"];
const TAVILY_NAME_MATCH = "tavily";

function safeDecryptJson(payload) {
  if (!payload) return {};
  try {
    const raw = decryptSecret(payload);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((v) => typeof v === "string" && v.trim()))];
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function parseSourceRef(sourceRef) {
  const raw = String(sourceRef || "").trim();
  if (!raw || raw === "auto") return { type: "auto", id: null };
  if (raw === "env") return { type: "env", id: null };

  if (raw.startsWith("workspace:")) {
    return { type: "workspace", id: raw.slice("workspace:".length) || null };
  }

  if (raw.startsWith("user:")) {
    return { type: "user", id: raw.slice("user:".length) || null };
  }

  return { type: "raw", id: raw };
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function extractAnyString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function extractTavilyApiKey(credentials = {}) {
  return extractAnyString(credentials, ["apiKey", "tavilyApiKey", "token", "accessToken", "key"]);
}

function maybeSmtpConfigFromCredentials(credentials = {}, integrationName = "") {
  const name = normalizeName(integrationName);

  const fromEmail = extractAnyString(credentials, ["fromEmail", "email", "username", "user", "smtpUser"]);
  const fromName = extractAnyString(credentials, ["fromName", "senderName", "name"]) || "Boatswain";

  if (name.includes("sendgrid")) {
    const apiKey = extractAnyString(credentials, ["apiKey", "token", "password"]);
    if (!apiKey) return null;
    return {
      host: "smtp.sendgrid.net",
      port: 587,
      secure: false,
      user: "apikey",
      pass: apiKey,
      fromEmail,
      fromName,
    };
  }

  const user = extractAnyString(credentials, ["smtpUser", "email", "username", "user"]);
  const pass = extractAnyString(credentials, ["smtpPass", "password", "appPassword", "pass", "apiKey", "token"]);

  let host = extractAnyString(credentials, ["smtpServer", "smtpHost", "host", "server"]);
  if (!host && name.includes("gmail")) host = "smtp.gmail.com";
  if (!host && (name.includes("outlook") || name.includes("office"))) host = "smtp.office365.com";

  const rawPort = credentials?.smtpPort ?? credentials?.port;
  const parsedPort = Number(rawPort);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587;
  const secure = credentials?.smtpSecure !== undefined
    ? toBoolean(credentials.smtpSecure, port === 465)
    : credentials?.secure !== undefined
      ? toBoolean(credentials.secure, port === 465)
      : port === 465;

  if (!host || !user || !pass) return null;

  return {
    host,
    port,
    secure,
    user,
    pass,
    fromEmail,
    fromName,
  };
}

function formatFromAddress({ fromEmail, fromName, user }) {
  const email = fromEmail || user || "";
  if (!email) return undefined;
  if (!fromName) return email;
  return `"${fromName}" <${email}>`;
}

async function getActor(userId, fallbackRole = null) {
  if (!userId) {
    return {
      userId: null,
      role: fallbackRole || null,
      workspaceId: null,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, workspaceId: true },
  });

  return {
    userId,
    role: user?.role || fallbackRole || null,
    workspaceId: user?.workspaceId || null,
  };
}

async function loadWorkspaceIntegrationById(workspaceId, integrationId) {
  if (!workspaceId || !integrationId) return null;
  const integration = await prisma.workspaceIntegration.findFirst({
    where: {
      id: integrationId,
      workspaceId,
      isEnabled: true,
      integrationType: { isActive: true },
    },
    include: { integrationType: true },
  });
  if (!integration) return null;
  return {
    scope: "workspace",
    ref: `workspace:${integration.id}`,
    id: integration.id,
    integrationType: integration.integrationType,
    credentials: safeDecryptJson(integration.encryptedConfig),
  };
}

async function loadUserIntegrationById(userId, integrationId) {
  if (!userId || !integrationId) return null;
  const integration = await prisma.userIntegration.findFirst({
    where: {
      id: integrationId,
      userId,
      integrationType: { isActive: true },
    },
    include: { integrationType: true },
  });
  if (!integration) return null;
  return {
    scope: "user",
    ref: `user:${integration.id}`,
    id: integration.id,
    integrationType: integration.integrationType,
    credentials: safeDecryptJson(integration.encryptedCredentials),
  };
}

async function listWorkspaceIntegrations(workspaceId, filter = {}) {
  if (!workspaceId) return [];
  const rows = await prisma.workspaceIntegration.findMany({
    where: {
      workspaceId,
      isEnabled: true,
      integrationType: { isActive: true, ...filter },
    },
    include: { integrationType: true },
    orderBy: { configuredAt: "desc" },
  });

  return rows.map((row) => ({
    scope: "workspace",
    ref: `workspace:${row.id}`,
    id: row.id,
    integrationType: row.integrationType,
    credentials: safeDecryptJson(row.encryptedConfig),
  }));
}

async function listUserIntegrations(userId, filter = {}) {
  if (!userId) return [];
  const rows = await prisma.userIntegration.findMany({
    where: {
      userId,
      integrationType: { isActive: true, ...filter },
    },
    include: { integrationType: true },
    orderBy: { linkedAt: "desc" },
  });

  return rows.map((row) => ({
    scope: "user",
    ref: `user:${row.id}`,
    id: row.id,
    integrationType: row.integrationType,
    credentials: safeDecryptJson(row.encryptedCredentials),
  }));
}

function toSourceLabel(source) {
  const scopeLabel = source.scope === "workspace" ? "Workspace" : "Personnel";
  return `${source.integrationType?.name || "Integration"} (${scopeLabel})`;
}

async function pickTavilySourceForRole({ actor, workspaceId, parsedSource }) {
  const isAdmin = actor.role === "ADMIN";

  if (parsedSource.type === "env") {
    if (!config.tavilyApiKey) {
      throw new Error("TAVILY_API_KEY non configuree sur la plateforme");
    }
    return {
      ref: "env",
      label: "Variable env TAVILY_API_KEY",
      apiKey: config.tavilyApiKey,
      scope: "system",
    };
  }

  if (parsedSource.type === "workspace") {
    const source = await loadWorkspaceIntegrationById(workspaceId, parsedSource.id);
    if (!source) throw new Error("Integration Tavily workspace introuvable");
    const apiKey = extractTavilyApiKey(source.credentials);
    if (!apiKey) throw new Error("La configuration Tavily workspace ne contient pas de cle API");
    return { ref: source.ref, label: toSourceLabel(source), apiKey, scope: "workspace" };
  }

  if (parsedSource.type === "user") {
    if (!isAdmin) throw new Error("Source Tavily personnelle reservee aux admins");
    const source = await loadUserIntegrationById(actor.userId, parsedSource.id);
    if (!source) throw new Error("Integration Tavily personnelle introuvable");
    const apiKey = extractTavilyApiKey(source.credentials);
    if (!apiKey) throw new Error("La configuration Tavily personnelle ne contient pas de cle API");
    return { ref: source.ref, label: toSourceLabel(source), apiKey, scope: "user" };
  }

  if (parsedSource.type === "raw") {
    if (isAdmin) {
      const userSource = await loadUserIntegrationById(actor.userId, parsedSource.id);
      const userKey = userSource ? extractTavilyApiKey(userSource.credentials) : "";
      if (userSource && userKey) {
        return { ref: userSource.ref, label: toSourceLabel(userSource), apiKey: userKey, scope: "user" };
      }
    }

    const workspaceSource = await loadWorkspaceIntegrationById(workspaceId, parsedSource.id);
    const workspaceKey = workspaceSource ? extractTavilyApiKey(workspaceSource.credentials) : "";
    if (workspaceSource && workspaceKey) {
      return { ref: workspaceSource.ref, label: toSourceLabel(workspaceSource), apiKey: workspaceKey, scope: "workspace" };
    }

    throw new Error("Source Tavily introuvable");
  }

  if (isAdmin) {
    const userSources = await listUserIntegrations(actor.userId, {
      name: { contains: TAVILY_NAME_MATCH, mode: "insensitive" },
    });
    for (const source of userSources) {
      const apiKey = extractTavilyApiKey(source.credentials);
      if (apiKey) {
        return { ref: source.ref, label: toSourceLabel(source), apiKey, scope: "user" };
      }
    }
  }

  const workspaceSources = await listWorkspaceIntegrations(workspaceId, {
    name: { contains: TAVILY_NAME_MATCH, mode: "insensitive" },
  });
  for (const source of workspaceSources) {
    const apiKey = extractTavilyApiKey(source.credentials);
    if (apiKey) {
      return { ref: source.ref, label: toSourceLabel(source), apiKey, scope: "workspace" };
    }
  }

  if (config.tavilyApiKey) {
    return {
      ref: "env",
      label: "Variable env TAVILY_API_KEY",
      apiKey: config.tavilyApiKey,
      scope: "system",
    };
  }

  throw new Error("Aucune cle Tavily disponible (integration ou variable d'environnement)");
}

export async function resolveTavilyApiKeyForAutomation({ workspaceId, userId, userRole, sourceRef }) {
  const actor = await getActor(userId, userRole);
  const parsedSource = parseSourceRef(sourceRef);
  return pickTavilySourceForRole({ actor, workspaceId, parsedSource });
}

function buildSmtpSourceRecord(source) {
  const smtp = maybeSmtpConfigFromCredentials(source.credentials, source.integrationType?.name || "");
  if (!smtp) return null;

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });

  return {
    ref: source.ref,
    label: toSourceLabel(source),
    transporter,
    from: formatFromAddress({ ...smtp, user: smtp.user }),
  };
}

export async function resolveSmtpTransportForAutomation({ workspaceId, userId, userRole, sourceRef }) {
  const actor = await getActor(userId, userRole);
  const parsedSource = parseSourceRef(sourceRef);

  if (parsedSource.type === "auto" || parsedSource.type === "env") {
    return null;
  }

  if (parsedSource.type === "workspace") {
    const source = await loadWorkspaceIntegrationById(workspaceId, parsedSource.id);
    if (!source) throw new Error("Source SMTP workspace introuvable");
    const smtp = buildSmtpSourceRecord(source);
    if (!smtp) throw new Error("La configuration workspace ne contient pas de credentials SMTP exploitables");
    return smtp;
  }

  if (parsedSource.type === "user") {
    if (actor.role !== "ADMIN") {
      throw new Error("Source SMTP personnelle reservee aux admins");
    }
    const source = await loadUserIntegrationById(actor.userId, parsedSource.id);
    if (!source) throw new Error("Source SMTP personnelle introuvable");
    const smtp = buildSmtpSourceRecord(source);
    if (!smtp) throw new Error("La configuration personnelle ne contient pas de credentials SMTP exploitables");
    return smtp;
  }

  if (parsedSource.type === "raw") {
    if (actor.role === "ADMIN") {
      const userSource = await loadUserIntegrationById(actor.userId, parsedSource.id);
      const userSmtp = userSource ? buildSmtpSourceRecord(userSource) : null;
      if (userSmtp) return userSmtp;
    }

    const workspaceSource = await loadWorkspaceIntegrationById(workspaceId, parsedSource.id);
    const workspaceSmtp = workspaceSource ? buildSmtpSourceRecord(workspaceSource) : null;
    if (workspaceSmtp) return workspaceSmtp;
  }

  throw new Error("Source SMTP introuvable ou non compatible");
}

async function listIaProviderCodes({ workspaceId, userId, userRole }) {
  const isAdmin = userRole === "ADMIN" || userRole === "GESTIONNAIRE";

  const workspaceLinks = workspaceId
    ? await prisma.clientServiceLink.findMany({
      where: {
        status: "active",
        OR: [
          { workspaceId },
          {
            workspaceId: null,
            owner: { workspaceId },
          },
        ],
        service: {
          category: { in: IA_SERVICE_CATEGORIES },
          isActive: true,
        },
      },
      include: { service: true },
      orderBy: { updatedAt: "desc" },
    })
    : [];

  const userLinks = (isAdmin && userId)
    ? await prisma.clientServiceLink.findMany({
      where: {
        ownerUserId: userId,
        status: "active",
        service: {
          category: { in: IA_SERVICE_CATEGORIES },
          isActive: true,
        },
      },
      include: { service: true },
      orderBy: { updatedAt: "desc" },
    })
    : [];

  const externalProviders = await prisma.externalService.findMany({
    where: {
      category: { in: IA_SERVICE_CATEGORIES },
      isActive: true,
    },
    orderBy: { id: "asc" },
  });

  const allCodes = [
    ...userLinks.map((row) => row.service.code),
    ...workspaceLinks.map((row) => row.service.code),
    ...externalProviders.map((row) => row.code),
  ];

  return uniqueStrings(allCodes);
}

function isSmtpLikeIntegration(integrationTypeName, category) {
  const name = normalizeName(integrationTypeName);
  const cat = normalizeName(category);
  return (
    cat === "mail"
    || name.includes("smtp")
    || name.includes("gmail")
    || name.includes("sendgrid")
    || name.includes("mail")
  );
}

export async function listAutomationMetadataOptions({ workspaceId, userId, userRole }) {
  const role = userRole || (await getActor(userId)).role || "GESTIONNAIRE";
  const isAdmin = role === "ADMIN";

  const iaProviderCodes = await listIaProviderCodes({ workspaceId, userId, userRole: role });
  const aiModelOptions = uniqueStrings(
    iaProviderCodes.flatMap((code) => AI_MODELS_BY_PROVIDER[code] || [])
  );

  const workspaceTavilySources = await listWorkspaceIntegrations(workspaceId, {
    name: { contains: TAVILY_NAME_MATCH, mode: "insensitive" },
  });

  const userTavilySources = isAdmin
    ? await listUserIntegrations(userId, {
      name: { contains: TAVILY_NAME_MATCH, mode: "insensitive" },
    })
    : [];

  const tavilySources = [
    ...userTavilySources,
    ...workspaceTavilySources,
  ]
    .map((source) => {
      const hasKey = Boolean(extractTavilyApiKey(source.credentials));
      return {
        ref: source.ref,
        label: toSourceLabel(source),
        scope: source.scope,
        hasKey,
      };
    })
    .filter((source) => source.hasKey);

  if (config.tavilyApiKey) {
    tavilySources.push({
      ref: "env",
      label: "Variable env TAVILY_API_KEY",
      scope: "system",
      hasKey: true,
    });
  }

  const workspaceMailSources = await listWorkspaceIntegrations(workspaceId, {
    OR: [
      { category: "mail" },
      { name: { contains: "smtp", mode: "insensitive" } },
      { name: { contains: "sendgrid", mode: "insensitive" } },
      { name: { contains: "gmail", mode: "insensitive" } },
    ],
  });

  const userMailSources = isAdmin
    ? await listUserIntegrations(userId, {
      OR: [
        { category: "mail" },
        { name: { contains: "smtp", mode: "insensitive" } },
        { name: { contains: "sendgrid", mode: "insensitive" } },
        { name: { contains: "gmail", mode: "insensitive" } },
      ],
    })
    : [];

  const smtpSources = [{ ref: "auto", label: "Auto (configuration SMTP existante)", scope: "system" }];

  [...userMailSources, ...workspaceMailSources]
    .filter((source) => isSmtpLikeIntegration(source.integrationType?.name, source.integrationType?.category))
    .forEach((source) => {
      const smtp = maybeSmtpConfigFromCredentials(source.credentials, source.integrationType?.name || "");
      if (!smtp) return;
      smtpSources.push({
        ref: source.ref,
        label: toSourceLabel(source),
        scope: source.scope,
      });
    });

  const defaultModels = aiModelOptions.length
    ? aiModelOptions
    : ["gpt-4o-mini", "claude-3-5-haiku-latest", "mistral-small-latest"];

  return {
    role,
    isAdmin,
    ai: {
      providerCodes: iaProviderCodes,
      modelOptions: defaultModels,
    },
    webSearch: {
      tavilySources,
    },
    email: {
      smtpSources,
    },
  };
}

export function normalizeDomainListInput(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[\n,;]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function normalizeKeyValueObject(value) {
  if (Array.isArray(value)) {
    const out = {};
    for (const row of value) {
      if (!row || typeof row !== "object") continue;
      const key = String(row.key || "").trim();
      if (!key) continue;
      out[key] = String(row.value ?? "");
    }
    return out;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, String(val ?? "")])
    );
  }

  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return Object.fromEntries(
          Object.entries(parsed).map(([key, val]) => [key, String(val ?? "")])
        );
      }
    } catch {
      return {};
    }
  }

  return {};
}

export function parseJsonLikeInput(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
