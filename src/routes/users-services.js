import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { decryptSecret, encryptSecret, maskSecret } from "../security/secrets.js";

const router = express.Router();

const collaboratorSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(254),
  roleLabel: z.string().min(2).max(80),
  status: z.enum(["active", "invited", "disabled"]).optional().default("invited")
});

const clientServiceUpdateSchema = z.object({
  label: z.string().min(2).max(80),
  apiKey: z.string().max(4096).optional().default(""),
  apiSecret: z.string().max(4096).optional().default(""),
  status: z.enum(["active", "inactive"]),
  config: z.record(z.string(), z.any()).optional().default({})
});

const adminUserSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128).optional(),
  role: z.enum(["admin", "client"]),
  companyName: z.string().max(120).optional().default(""),
  tenantId: z.string().cuid().optional()
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128)
});

const externalServiceSchema = z.object({
  code: z.string().min(3).max(80),
  name: z.string().min(2).max(120),
  category: z.enum(["crm", "ia-cloud", "ia-local", "other"]),
  isActive: z.boolean().optional().default(true),
  defaultConfig: z.record(z.string(), z.any()).optional().default({})
});

/**
 * Maps user-facing category strings to Prisma enum values.
 */
function toPrismaCategoryEnum(category) {
  const map = {
    "crm": "crm",
    "ia-cloud": "ia_cloud",
    "ia_cloud": "ia_cloud",
    "ia-local": "ia_local",
    "ia_local": "ia_local",
    "other": "other"
  };
  return map[category] || "other";
}

function toApiCategory(prismaValue) {
  const map = {
    "ia_cloud": "ia-cloud",
    "ia_local": "ia-local"
  };
  return map[prismaValue] || prismaValue;
}

async function ensureDefaultSellsyServices() {
  await prisma.externalService.upsert({
    where: { code: "sellsy-token" },
    update: { name: "Sellsy (API Token)", category: "crm", isActive: true },
    create: { code: "sellsy-token", name: "Sellsy (API Token)", category: "crm", isActive: true, defaultConfig: "{}" }
  });

  await prisma.externalService.upsert({
    where: { code: "sellsy-oauth" },
    update: { name: "Sellsy (OAuth)", category: "crm", isActive: true },
    create: { code: "sellsy-oauth", name: "Sellsy (OAuth)", category: "crm", isActive: true, defaultConfig: "{}" }
  });
}

async function ensureClientSellsyLinks(userId) {
  const crmServices = await prisma.externalService.findMany({
    where: { category: "crm", isActive: true },
    select: { id: true, name: true }
  });

  for (const service of crmServices) {
    await prisma.clientServiceLink.upsert({
      where: {
        ownerUserId_serviceId: { ownerUserId: userId, serviceId: service.id }
      },
      update: {},
      create: {
        ownerUserId: userId,
        serviceId: service.id,
        label: `${service.name} Connection`,
        apiKeyMasked: "",
        apiSecretMasked: "",
        status: "inactive",
        configJson: "{}"
      }
    });
  }
}

async function disableOtherAiProviders(activeServiceId) {
  await prisma.externalService.updateMany({
    where: {
      id: { not: activeServiceId },
      category: { in: ["ia_cloud", "ia_local"] }
    },
    data: { isActive: false }
  });
}

async function syncSellsyConnectionStatus(userId) {
  const activeSellsyCount = await prisma.$queryRaw`
    SELECT COUNT(*)::int as count
    FROM client_service_links csl
    JOIN external_services es ON es.id = csl.service_id
    WHERE csl.owner_user_id = ${userId}
      AND csl.status = 'active'
      AND es.code IN ('sellsy-token', 'sellsy-oauth')
      AND es.is_active = true`;

  const count = activeSellsyCount[0]?.count || 0;

  await prisma.clientPlan.updateMany({
    where: { userId },
    data: {
      sellsyConnectionStatus: count > 0 ? "active" : "inactive",
      updatedAt: new Date()
    }
  });
}

router.get("/client/me", requireAuth, requireRole("client", "admin"), async (req, res) => {
  const userId = req.user.sub;

  // Ensure Sellsy is always configurable by clients, even without prior admin setup.
  await ensureDefaultSellsyServices();
  await ensureClientSellsyLinks(userId);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, companyName: true, whatsappPhone: true, createdAt: true }
  });

  const clientPlan = await prisma.clientPlan.findUnique({
    where: { userId },
    include: { plan: { select: { name: true, collaboratorLimit: true } } }
  });

  const plan = clientPlan ? { name: clientPlan.plan.name, collaboratorLimit: clientPlan.plan.collaboratorLimit } : null;

  const collaborators = await prisma.collaborator.findMany({
    where: { ownerUserId: userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, email: true, roleLabel: true, status: true, createdAt: true }
  });

  const serviceRows = await prisma.$queryRaw`
    SELECT csl.id, csl.label, csl.api_key_masked as "apiKeyMasked", csl.api_secret_masked as "apiSecretMasked",
           csl.api_key_encrypted as "apiKeyEncrypted", csl.api_secret_encrypted as "apiSecretEncrypted",
           csl.status, csl.config_json as "configJson", es.id as "serviceId", es.code, es.name, es.category
    FROM client_service_links csl
    JOIN external_services es ON es.id = csl.service_id
    WHERE csl.owner_user_id = ${userId}
    ORDER BY es.name ASC`;

  const services = serviceRows.map((row) => ({
    id: row.id,
    label: row.label,
    apiKeyMasked: row.apiKeyMasked,
    apiSecretMasked: row.apiSecretMasked,
    status: row.status,
    serviceId: row.serviceId,
    code: row.code,
    name: row.name,
    category: toApiCategory(row.category),
    config: JSON.parse(row.configJson || "{}"),
    hasApiKey: Boolean(row.apiKeyEncrypted),
    hasApiSecret: Boolean(row.apiSecretEncrypted)
  }));

  return res.json({
    user,
    plan,
    collaborators,
    collaboratorUsage: {
      used: collaborators.length,
      limit: plan?.collaboratorLimit || 0
    },
    services
  });
});

router.post("/client/collaborators", requireAuth, requireRole("client", "admin"), async (req, res) => {
  const parse = collaboratorSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const userId = req.user.sub;

  const clientPlan = await prisma.clientPlan.findUnique({
    where: { userId },
    include: { plan: { select: { collaboratorLimit: true } } }
  });

  const current = await prisma.collaborator.count({
    where: { ownerUserId: userId }
  });

  if (current >= (clientPlan?.plan?.collaboratorLimit || 0)) {
    return res.status(409).json({ error: "Plan collaborator limit reached" });
  }

  await prisma.collaborator.create({
    data: {
      ownerUserId: userId,
      name: parse.data.name,
      email: parse.data.email,
      roleLabel: parse.data.roleLabel,
      status: parse.data.status
    }
  });

  await logAudit(userId, "COLLABORATOR_CREATED", { email: parse.data.email });
  return res.status(201).json({ message: "Collaborator created" });
});

router.delete("/client/collaborators/:id", requireAuth, requireRole("client", "admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid collaborator id" });
  }

  const deleted = await prisma.collaborator.deleteMany({
    where: { id, ownerUserId: req.user.sub }
  });

  if (!deleted.count) {
    return res.status(404).json({ error: "Collaborator not found" });
  }

  await logAudit(req.user.sub, "COLLABORATOR_DELETED", { collaboratorId: id });
  return res.json({ message: "Collaborator deleted" });
});

router.put("/client/services/:id", requireAuth, requireRole("client", "admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid service link id" });
  }

  const parse = clientServiceUpdateSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const payload = parse.data;
  const current = await prisma.clientServiceLink.findFirst({
    where: { id, ownerUserId: req.user.sub },
    select: {
      apiKeyEncrypted: true,
      apiSecretEncrypted: true,
      apiKeyMasked: true,
      apiSecretMasked: true
    }
  });

  if (!current) {
    return res.status(404).json({ error: "Service link not found" });
  }

  const keyToStore = payload.apiKey ? encryptSecret(payload.apiKey) : current.apiKeyEncrypted;
  const secretToStore = payload.apiSecret ? encryptSecret(payload.apiSecret) : current.apiSecretEncrypted;

  const updated = await prisma.clientServiceLink.updateMany({
    where: { id, ownerUserId: req.user.sub },
    data: {
      label: payload.label,
      apiKeyMasked: payload.apiKey ? maskSecret(payload.apiKey) : current.apiKeyMasked,
      apiSecretMasked: payload.apiSecret ? maskSecret(payload.apiSecret) : current.apiSecretMasked,
      apiKeyEncrypted: keyToStore,
      apiSecretEncrypted: secretToStore,
      status: payload.status,
      configJson: JSON.stringify(payload.config),
      updatedAt: new Date()
    }
  });

  if (!updated.count) {
    return res.status(404).json({ error: "Service link not found" });
  }

  await logAudit(req.user.sub, "CLIENT_SERVICE_UPDATED", { serviceLinkId: id });

  const serviceRow = await prisma.$queryRaw`
    SELECT es.code
    FROM client_service_links csl
    JOIN external_services es ON es.id = csl.service_id
    WHERE csl.id = ${id} AND csl.owner_user_id = ${req.user.sub}`;

  if (serviceRow[0] && (serviceRow[0].code === "sellsy-token" || serviceRow[0].code === "sellsy-oauth")) {
    await syncSellsyConnectionStatus(req.user.sub);
  }

  return res.json({ message: "Service updated" });
});

router.post("/client/services/:id/test", requireAuth, requireRole("client", "admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid service link id" });
  }

  const link = await prisma.$queryRaw`
    SELECT csl.id, csl.config_json as "configJson", csl.api_key_encrypted as "apiKeyEncrypted",
           csl.api_secret_encrypted as "apiSecretEncrypted", es.code, es.category, es.name
    FROM client_service_links csl
    JOIN external_services es ON es.id = csl.service_id
    WHERE csl.id = ${id} AND csl.owner_user_id = ${req.user.sub}`;

  if (!link[0]) {
    return res.status(404).json({ error: "Service link not found" });
  }

  const row = link[0];
  const cfg = JSON.parse(row.configJson || "{}");
  const apiKey = row.apiKeyEncrypted ? decryptSecret(row.apiKeyEncrypted) : "";
  const apiSecret = row.apiSecretEncrypted ? decryptSecret(row.apiSecretEncrypted) : "";

  try {
    const result = await testProviderConnection(row.code, apiKey, apiSecret, cfg);
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ error: `Connection test failed: ${error.message}` });
  }
});

// ── Test provider connection (reusable – used by both saved links and pre-save testing) ──
const testProviderSchema = z.object({
  providerCode: z.string().min(1),
  apiKey: z.string().max(4096).optional().default(""),
  apiSecret: z.string().max(4096).optional().default(""),
  config: z.record(z.string(), z.any()).optional().default({})
});

/**
 * Valide qu'une URL fournie par l'utilisateur est acceptable pour un provider local.
 * Accepte n'importe quel hostname (Ollama peut tourner sur un serveur distant),
 * mais refuse les protocoles dangereux et les ports non-HTTP.
 */
function validateProviderUrl(urlString, defaultUrl) {
  const raw = String(urlString || defaultUrl || "").replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid provider URL format");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Provider URL must use http or https");
  }
  // Bloquer les schémas de redirection via @ (user:pass@host)
  if (parsed.username || parsed.password) {
    throw new Error("Provider URL must not contain credentials");
  }
  return parsed.origin;
}

async function testProviderConnection(code, apiKey, apiSecret, cfg) {
  // ── IA Cloud providers ──
  if (code === "openai-cloud") {
    if (!apiKey) throw new Error("Missing OpenAI API key");
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!r.ok) throw new Error(`OpenAI returned ${r.status}`);
    return { ok: true, message: "OpenAI connection successful" };
  }

  if (code === "anthropic-cloud") {
    if (!apiKey) throw new Error("Missing Anthropic API key");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      })
    });
    // 200 = works, 400 = auth ok but bad request is fine too, only 401/403 = bad key
    if (r.status === 401 || r.status === 403) throw new Error("Invalid Anthropic API key");
    return { ok: true, message: "Anthropic connection successful" };
  }

  if (code === "google-cloud") {
    if (!apiKey) throw new Error("Missing Google AI API key");
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!r.ok) throw new Error(`Google AI returned ${r.status}`);
    return { ok: true, message: "Google AI connection successful" };
  }

  if (code === "mistral-cloud") {
    if (!apiKey) throw new Error("Missing Mistral API key");
    const r = await fetch("https://api.mistral.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!r.ok) throw new Error(`Mistral returned ${r.status}`);
    return { ok: true, message: "Mistral connection successful" };
  }

  if (code === "openrouter-cloud") {
    if (!apiKey) throw new Error("Missing OpenRouter API key");
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!r.ok) throw new Error(`OpenRouter returned ${r.status}`);
    return { ok: true, message: "OpenRouter connection successful" };
  }

  // ── IA Local providers ──
  if (code === "ollama-local") {
    const baseUrl = validateProviderUrl(cfg.host, "http://localhost:11434");
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Ollama returned ${r.status}`);
    const data = await r.json();
    const modelCount = data?.models?.length || 0;
    return { ok: true, message: `Ollama connected (${modelCount} model${modelCount !== 1 ? "s" : ""})` };
  }

  if (code === "lmstudio-local") {
    const baseUrl = validateProviderUrl(cfg.host, "http://localhost:1234");
    const r = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`LM Studio returned ${r.status}`);
    return { ok: true, message: "LM Studio connection successful" };
  }

  // ── CRM / Sellsy providers ──
  if (code === "sellsy-token") {
    if (!apiKey) throw new Error("Missing Sellsy API token");
    const r = await fetch("https://api.sellsy.com/v2/contacts?limit=1", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (r.status === 401 || r.status === 403) throw new Error("Invalid Sellsy token");
    if (!r.ok && r.status !== 404) throw new Error(`Sellsy returned ${r.status}`);
    return { ok: true, message: "Sellsy token valid" };
  }

  if (code === "sellsy-oauth") {
    if (!apiKey || !apiSecret) throw new Error("Missing Sellsy Client ID / Client Secret");
    const r = await fetch("https://login.sellsy.com/oauth2/access-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: apiKey,
        client_secret: apiSecret
      })
    });
    if (!r.ok) throw new Error(`Sellsy OAuth failed (${r.status})`);
    return { ok: true, message: "Sellsy OAuth credentials valid" };
  }

  return { ok: true, message: `No dedicated test for provider "${code}"` };
}

// ── Changement de mot de passe (client) ──
router.post("/client/change-password", requireAuth, requireRole("client", "admin"), async (req, res) => {
  const parse = changePasswordSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { id: true, passwordHash: true }
  });
  if (!user) return res.status(404).json({ error: "User not found" });

  if (!bcrypt.compareSync(parse.data.currentPassword, user.passwordHash)) {
    await logAudit(req.user.sub, "PASSWORD_CHANGE_FAILED", {});
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  await prisma.user.update({
    where: { id: req.user.sub },
    data: { passwordHash: bcrypt.hashSync(parse.data.newPassword, 12) }
  });

  await logAudit(req.user.sub, "PASSWORD_CHANGED", {});
  return res.json({ message: "Password updated successfully" });
});

// ── Réinitialisation de mot de passe (admin uniquement) ──
router.post("/admin/users/:id/reset-password", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  const parse = z.object({ newPassword: z.string().min(8).max(128) }).safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  try {
    await prisma.user.update({
      where: { id },
      data: { passwordHash: bcrypt.hashSync(parse.data.newPassword, 12) }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }
    throw err;
  }

  await logAudit(req.user.sub, "ADMIN_PASSWORD_RESET", { targetUserId: id });
  return res.json({ message: "Password reset successfully" });
});

// ── Fetch available models from a local provider (proxy to bypass CSP) ──
router.get("/provider-models", requireAuth, requireRole("admin"), async (req, res) => {
  const { code, host, apiKey } = req.query;
  if (!code) return res.status(400).json({ error: "code required" });

  try {
    let models = [];

    // ── Cloud providers ──
    if (code === "mistral-cloud") {
      if (!apiKey) return res.status(400).json({ error: "apiKey required for mistral-cloud" });
      const r = await fetch("https://api.mistral.ai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!r.ok) return res.status(502).json({ error: `Mistral returned ${r.status}` });
      const data = await r.json();
      models = (data.data || []).map((m) => m.id);
    } else if (code === "openai-cloud") {
      if (!apiKey) return res.status(400).json({ error: "apiKey required for openai-cloud" });
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!r.ok) return res.status(502).json({ error: `OpenAI returned ${r.status}` });
      const data = await r.json();
      models = (data.data || []).map((m) => m.id).filter((id) => id.includes("gpt"));
    } else if (code === "anthropic-cloud") {
      if (!apiKey) return res.status(400).json({ error: "apiKey required for anthropic-cloud" });
      // Anthropic doesn't have a models endpoint, return common models
      models = ["claude-opus-4-1", "claude-sonnet-4-20250514", "claude-haiku-3-5"];
    } else if (code === "openrouter-cloud") {
      if (!apiKey) return res.status(400).json({ error: "apiKey required for openrouter-cloud" });
      const r = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!r.ok) return res.status(502).json({ error: `OpenRouter returned ${r.status}` });
      const data = await r.json();
      models = (data.data || []).map((m) => m.id);
    }
    // ── Local providers ──
    else if (code === "ollama-local") {
      if (!host) return res.status(400).json({ error: "host required for ollama-local" });
      const cleanHost = String(host).replace(/\/$/, "");
      const r = await fetch(`${cleanHost}/api/tags`);
      if (!r.ok) return res.status(502).json({ error: `Ollama returned ${r.status}` });
      const data = await r.json();
      models = (data.models || []).map((m) => m.name);
    } else if (code === "lmstudio-local") {
      if (!host) return res.status(400).json({ error: "host required for lmstudio-local" });
      const cleanHost = String(host).replace(/\/$/, "");
      const r = await fetch(`${cleanHost}/v1/models`);
      if (!r.ok) return res.status(502).json({ error: `LMStudio returned ${r.status}` });
      const data = await r.json();
      models = (data.data || []).map((m) => m.id);
    } else {
      return res.status(400).json({ error: "Provider model discovery not supported" });
    }

    return res.json({ models: models.slice(0, 50) }); // Limit to 50 models
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

// ── Test a provider before saving (authentification obligatoire) ──
router.post("/test-provider", requireAuth, async (req, res) => {
  const parse = testProviderSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { providerCode, apiKey, apiSecret, config: cfg } = parse.data;

  try {
    const result = await testProviderConnection(providerCode, apiKey, apiSecret, cfg);
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.get("/admin/users", requireAuth, requireRole("admin"), async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, companyName: true, createdAt: true }
  });
  return res.json({ users });
});

router.post("/admin/users", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = adminUserSchema.extend({ password: z.string().min(8).max(128) }).safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const payload = parse.data;

  const user = await prisma.user.create({
    data: {
      email: payload.email.toLowerCase(),
      passwordHash: bcrypt.hashSync(payload.password, 12),
      role: payload.role,
      companyName: payload.companyName || null,
      tenantId: payload.tenantId || null
    }
  });

  if (payload.role === "client") {
    const starter = await prisma.plan.findUnique({
      where: { name: "Starter" },
      select: { id: true }
    });

    if (starter) {
      // Create client plan (ignore if already exists)
      try {
        await prisma.clientPlan.create({
          data: {
            userId: user.id,
            planId: starter.id,
            sellsyConnectionStatus: "inactive"
          }
        });
      } catch (err) {
        // Ignore unique constraint violation
        if (err.code !== "P2002") throw err;
      }

      // Create service links for all active services
      const allServices = await prisma.externalService.findMany({
        where: { isActive: true },
        select: { id: true, name: true }
      });

      for (const service of allServices) {
        try {
          await prisma.clientServiceLink.create({
            data: {
              ownerUserId: user.id,
              serviceId: service.id,
              label: `${service.name} Connection`,
              apiKeyMasked: "",
              apiSecretMasked: "",
              status: "inactive",
              configJson: "{}"
            }
          });
        } catch (err) {
          // Ignore unique constraint violation
          if (err.code !== "P2002") throw err;
        }
      }
    }
  }

  await logAudit(req.user.sub, "ADMIN_USER_CREATED", { email: payload.email, role: payload.role });
  return res.status(201).json({ message: "User created" });
});

router.patch("/admin/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  const parse = adminUserSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const payload = parse.data;
  const data = {
    email: payload.email.toLowerCase(),
    role: payload.role,
    companyName: payload.companyName || null
  };

  if (payload.password) {
    data.passwordHash = bcrypt.hashSync(payload.password, 12);
  }

  try {
    await prisma.user.update({
      where: { id },
      data
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }
    throw err;
  }

  await logAudit(req.user.sub, "ADMIN_USER_UPDATED", { userId: id });
  return res.json({ message: "User updated" });
});

router.delete("/admin/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  if (id === req.user.sub) {
    return res.status(409).json({ error: "Cannot delete current admin account" });
  }

  try {
    await prisma.user.delete({
      where: { id }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }
    throw err;
  }

  await logAudit(req.user.sub, "ADMIN_USER_DELETED", { userId: id });
  return res.json({ message: "User deleted" });
});

router.get("/admin/external-services", requireAuth, requireRole("admin"), async (_req, res) => {
  const serviceRows = await prisma.externalService.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      category: true,
      isActive: true,
      defaultConfig: true,
      createdAt: true
    }
  });

  const services = serviceRows.map((s) => {
    const defaultConfig = JSON.parse(s.defaultConfig || "{}");

    // ── Decrypt sensitive data before sending to admin ──
    if (defaultConfig.apiKey && defaultConfig._apiKeyEncrypted) {
      defaultConfig.apiKey = decryptSecret(defaultConfig.apiKey);
      delete defaultConfig._apiKeyEncrypted;
    }
    if (defaultConfig.apiSecret && defaultConfig._apiSecretEncrypted) {
      defaultConfig.apiSecret = decryptSecret(defaultConfig.apiSecret);
      delete defaultConfig._apiSecretEncrypted;
    }

    return { ...s, category: toApiCategory(s.category), defaultConfig };
  });

  return res.json({ services });
});

router.post("/admin/external-services", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = externalServiceSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const payload = parse.data;

  // ── Encrypt sensitive data in defaultConfig before storing ──
  const defaultConfig = { ...payload.defaultConfig };
  if (defaultConfig.apiKey) {
    defaultConfig.apiKey = encryptSecret(defaultConfig.apiKey);
    defaultConfig._apiKeyEncrypted = true;
  }
  if (defaultConfig.apiSecret) {
    defaultConfig.apiSecret = encryptSecret(defaultConfig.apiSecret);
    defaultConfig._apiSecretEncrypted = true;
  }

  let created;
  try {
    created = await prisma.externalService.create({
      data: {
        code: payload.code,
        name: payload.name,
        category: toPrismaCategoryEnum(payload.category),
        isActive: payload.isActive,
        defaultConfig: JSON.stringify(defaultConfig)
      }
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: `External service with code '${payload.code}' already exists` });
    }
    throw err;
  }

  if (payload.isActive && (payload.category === "ia-cloud" || payload.category === "ia-local")) {
    await disableOtherAiProviders(created.id);
  }

  await logAudit(req.user.sub, "EXTERNAL_SERVICE_CREATED", { code: payload.code });
  return res.status(201).json({ message: "External service created" });
});

router.patch("/admin/external-services/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid service id" });
  }

  const parse = externalServiceSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const payload = parse.data;

  // ── Encrypt sensitive data in defaultConfig before storing ──
  const defaultConfig = { ...payload.defaultConfig };
  if (defaultConfig.apiKey) {
    defaultConfig.apiKey = encryptSecret(defaultConfig.apiKey);
    defaultConfig._apiKeyEncrypted = true;
  }
  if (defaultConfig.apiSecret) {
    defaultConfig.apiSecret = encryptSecret(defaultConfig.apiSecret);
    defaultConfig._apiSecretEncrypted = true;
  }

  try {
    await prisma.externalService.update({
      where: { id },
      data: {
        code: payload.code,
        name: payload.name,
        category: toPrismaCategoryEnum(payload.category),
        isActive: payload.isActive,
        defaultConfig: JSON.stringify(defaultConfig)
      }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "External service not found" });
    }
    throw err;
  }

  if (payload.isActive && (payload.category === "ia-cloud" || payload.category === "ia-local")) {
    await disableOtherAiProviders(id);
  }

  await logAudit(req.user.sub, "EXTERNAL_SERVICE_UPDATED", { serviceId: id });
  return res.json({ message: "External service updated" });
});

router.delete("/admin/external-services/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid service id" });
  }

  try {
    await prisma.externalService.delete({
      where: { id }
    });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "External service not found" });
    }
    throw err;
  }

  await logAudit(req.user.sub, "EXTERNAL_SERVICE_DELETED", { serviceId: id });
  return res.json({ message: "External service deleted" });
});

// ── Update user profile (client/admin) ──
router.put("/api/users/profile", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const parse = z.object({
    whatsappPhone: z.string().min(6).max(20).nullable().optional()
  }).safeParse(req.body);

  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        whatsappPhone: parse.data.whatsappPhone || null
      }
    });
    
    await logAudit(userId, "USER_PROFILE_UPDATED", { whatsappPhone: parse.data.whatsappPhone });
    return res.json({ message: "Profile updated successfully" });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Ce numéro WhatsApp est déjà utilisé par un autre compte." });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
