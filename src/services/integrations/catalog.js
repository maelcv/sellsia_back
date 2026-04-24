function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function toUniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function toStringArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(/[\n,;]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeFieldDefinition(value) {
  if (isPlainObject(value)) return { ...value };
  if (typeof value === "number") return { type: "number", default: value };
  if (typeof value === "boolean") return { type: "boolean", default: value };
  if (typeof value === "string") return { type: "string", default: value };
  return { type: "string" };
}

function normalizeFieldMap(value) {
  if (!isPlainObject(value)) return {};

  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    out[key] = normalizeFieldDefinition(rawValue);
  }
  return out;
}

function normalizeScopeFields(section) {
  if (!isPlainObject(section)) return {};

  if (isPlainObject(section.fields)) {
    return normalizeFieldMap(section.fields);
  }

  if (isPlainObject(section.schema)) {
    return normalizeFieldMap(section.schema);
  }

  if (isPlainObject(section.configSchema)) {
    return normalizeFieldMap(section.configSchema);
  }

  return normalizeFieldMap(section);
}

function hasScopedSchema(rawSchema) {
  if (!isPlainObject(rawSchema)) return false;
  return ["version", "platform", "workspace", "user", "scopes", "bindings", "oauth"]
    .some((key) => Object.prototype.hasOwnProperty.call(rawSchema, key));
}

function normalizeOauthProvider(value) {
  const normalized = normalizeName(value);
  if (normalized === "google" || normalized === "office") return normalized;
  return null;
}

function inferOauthProvider(integrationType = {}) {
  const name = normalizeName(integrationType?.name);
  if (name.includes("gmail") || name.includes("google")) {
    return "google";
  }
  if (name.includes("outlook") || name.includes("office") || name.includes("microsoft")) {
    return "office";
  }
  return null;
}

function inferPlatformFields(integrationType = {}, oauthProvider = null) {
  if (oauthProvider === "google") {
    return {
      clientId: {
        type: "string",
        label: "Google OAuth Client ID",
        required: true,
      },
      clientSecret: {
        type: "password",
        label: "Google OAuth Client Secret",
        required: true,
      },
      redirectUri: {
        type: "string",
        label: "Google OAuth Redirect URI",
        required: false,
      },
    };
  }

  if (oauthProvider === "office") {
    return {
      clientId: {
        type: "string",
        label: "Office OAuth Client ID",
        required: true,
      },
      clientSecret: {
        type: "password",
        label: "Office OAuth Client Secret",
        required: true,
      },
      tenantId: {
        type: "string",
        label: "Microsoft Tenant ID",
        default: "common",
        required: false,
      },
      redirectUri: {
        type: "string",
        label: "Office OAuth Redirect URI",
        required: false,
      },
    };
  }

  return {};
}

function inferWorkspaceFields(integrationType = {}, oauthProvider = null) {
  const name = normalizeName(integrationType?.name);

  if (name === "sellsy") {
    return {
      apiUrl: {
        type: "string",
        label: "Sellsy API URL",
        placeholder: "https://api.sellsy.com",
        required: true,
      },
    };
  }

  if (name.includes("smtp custom")) {
    return {
      smtpHost: { type: "string", label: "SMTP Host", required: true },
      smtpPort: { type: "number", label: "SMTP Port", required: true, default: 587 },
      smtpSecure: { type: "boolean", label: "SMTP Secure", required: false },
      fromEmail: { type: "string", label: "Sender Email", required: false },
      fromName: { type: "string", label: "Sender Name", required: false },
    };
  }

  if (name.includes("sendgrid")) {
    return {
      apiKey: { type: "password", label: "SendGrid API Key", required: true },
      fromEmail: { type: "string", label: "Sender Email", required: false },
      fromName: { type: "string", label: "Sender Name", required: false },
    };
  }

  if (name.includes("tavily")) {
    return {
      apiKey: { type: "password", label: "Tavily API Key", required: true },
      endpoint: {
        type: "string",
        label: "API Endpoint",
        default: "https://api.tavily.com",
        required: false,
      },
    };
  }

  if (oauthProvider) {
    return {};
  }

  return {};
}

function inferUserFields(integrationType = {}, oauthProvider = null) {
  const name = normalizeName(integrationType?.name);

  if (oauthProvider) {
    return {};
  }

  if (name === "sellsy") {
    return {
      token: { type: "password", label: "Sellsy API Token", required: false },
      key: { type: "password", label: "Sellsy API Key", required: false },
      clientId: { type: "password", label: "Sellsy OAuth Client ID", required: false },
      clientSecret: { type: "password", label: "Sellsy OAuth Client Secret", required: false },
      refreshToken: { type: "password", label: "Sellsy OAuth Refresh Token", required: false },
      accessToken: { type: "password", label: "Sellsy OAuth Access Token", required: false },
    };
  }

  if (name.includes("smtp")) {
    return {
      email: { type: "string", label: "Mailbox Email", required: true },
      password: { type: "password", label: "Mailbox Password", required: true },
    };
  }

  if (name.includes("caldav")) {
    return {
      url: { type: "string", label: "CalDAV URL", required: true },
      username: { type: "string", label: "Username", required: true },
      password: { type: "password", label: "Password", required: true },
    };
  }

  return {};
}

export function inferIntegrationBindings(integrationType = {}) {
  const name = normalizeName(integrationType?.name);
  const category = normalizeName(integrationType?.category);

  const tools = [];
  const subAgents = [];
  const automationBlocks = [];

  if (
    category === "mail"
    || name.includes("smtp")
    || name.includes("gmail")
    || name.includes("mail")
    || name.includes("sendgrid")
    || name.includes("outlook")
  ) {
    tools.push("send_email");
    subAgents.push("commercial", "directeur");
    automationBlocks.push("action:send_email");
  }

  if (
    category === "calendar"
    || name.includes("calendar")
    || name.includes("agenda")
    || name.includes("caldav")
    || name.includes("outlook")
  ) {
    tools.push("create_calendar_event");
    subAgents.push("commercial");
    automationBlocks.push("action:create_calendar_event");
  }

  if (name.includes("tavily") || name.includes("web search") || name.includes("search")) {
    tools.push("web_search", "web_scrape");
    subAgents.push("technicien", "commercial");
    automationBlocks.push("action:web_search", "action:web_scrape");
  }

  if (category === "storage" || name.includes("vault") || name.includes("knowledge")) {
    tools.push("vault_read", "vault_write", "vault_delete");
    subAgents.push("technicien");
    automationBlocks.push("action:vault_read", "action:vault_write", "action:vault_delete");
  }

  if (category === "crm" || name.includes("sellsy") || name.includes("hubspot") || name.includes("salesforce")) {
    tools.push("sellsy_search_companies", "sellsy_search_contacts", "sellsy_get_opportunities");
    subAgents.push("commercial", "directeur");
  }

  if (category === "ai_provider") {
    automationBlocks.push("action:ai_generate");
  }

  return {
    tools: toUniqueStrings(tools),
    subAgents: toUniqueStrings(subAgents),
    automationBlocks: toUniqueStrings(automationBlocks),
  };
}

export function normalizeIntegrationConfigSchema(rawSchema = {}, integrationType = {}) {
  const schema = isPlainObject(rawSchema) ? rawSchema : {};
  const scopedSchema = hasScopedSchema(schema);

  const inferredBindings = inferIntegrationBindings(integrationType);
  const inferredOauthProvider = inferOauthProvider(integrationType);

  let platformFields = {};
  let workspaceFields = {};
  let userFields = {};

  if (scopedSchema) {
    const scoped = isPlainObject(schema.scopes) ? schema.scopes : {};

    platformFields = normalizeScopeFields(schema.platform || schema.platformConfig || scoped.platform);
    workspaceFields = normalizeScopeFields(schema.workspace || schema.workspaceConfig || scoped.workspace);
    userFields = normalizeScopeFields(schema.user || schema.userConfig || scoped.user);

    if (!Object.keys(workspaceFields).length && isPlainObject(schema.configSchema)) {
      workspaceFields = normalizeFieldMap(schema.configSchema);
    }
  } else {
    workspaceFields = normalizeFieldMap(schema);
  }

  const oauthProvider = normalizeOauthProvider(schema?.oauth?.provider || schema?.oauthProvider || inferredOauthProvider);

  if (!scopedSchema && oauthProvider) {
    // Legacy flat schemas for OAuth providers should not force workspace-level credentials.
    workspaceFields = {};
  }

  if (!Object.keys(platformFields).length) {
    platformFields = inferPlatformFields(integrationType, oauthProvider);
  }
  if (!Object.keys(workspaceFields).length) {
    workspaceFields = inferWorkspaceFields(integrationType, oauthProvider);
  }
  if (!Object.keys(userFields).length) {
    userFields = inferUserFields(integrationType, oauthProvider);
  }

  const rawBindings = isPlainObject(schema.bindings) ? schema.bindings : {};
  const tools = toUniqueStrings([
    ...inferredBindings.tools,
    ...toStringArray(rawBindings.tools),
    ...toStringArray(schema.tools),
    ...toStringArray(schema.allowedTools),
  ]);
  const subAgents = toUniqueStrings([
    ...inferredBindings.subAgents,
    ...toStringArray(rawBindings.subAgents),
    ...toStringArray(rawBindings.subagents),
    ...toStringArray(schema.subAgents),
    ...toStringArray(schema.allowedSubAgents),
  ]);
  const automationBlocks = toUniqueStrings([
    ...inferredBindings.automationBlocks,
    ...toStringArray(rawBindings.automationBlocks),
    ...toStringArray(rawBindings.blocks),
    ...toStringArray(schema.automationBlocks),
  ]);

  return {
    version: 2,
    platform: { fields: platformFields },
    workspace: { fields: workspaceFields },
    user: { fields: userFields },
    bindings: {
      tools,
      subAgents,
      automationBlocks,
    },
    oauth: {
      provider: oauthProvider,
    },
  };
}

export function getIntegrationBindings(integrationType = {}) {
  return normalizeIntegrationConfigSchema(integrationType?.configSchema, integrationType).bindings;
}

export function getIntegrationAutomationBlocks(integrationType = {}) {
  return getIntegrationBindings(integrationType).automationBlocks;
}

export const RUDIMENTARY_AUTOMATION_BLOCK_IDS = [
  "trigger:webhook",
  "trigger:schedule",
  "trigger:event",
  "trigger:manual",
  "logic:condition",
  "logic:delay",
  "logic:loop",
  "action:http_request",
  "action:ai_generate",
  "action:generate_report",
  "action:vault_read",
  "action:vault_write",
  "action:vault_delete",
];
