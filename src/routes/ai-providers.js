import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole, isPlatformAdminRole } from "../middleware/auth.js";
import { encryptSecret, decryptSecret, maskSecret } from "../security/secrets.js";

const router = Router();

const PROVIDER_CODE_BY_NAME = {
  openai: "openai-cloud",
  anthropic: "anthropic-cloud",
  mistral: "mistral-cloud",
  openrouter: "openrouter-cloud",
  ollama: "ollama-local",
  "lm studio": "lmstudio-local",
  lmstudio: "lmstudio-local",
};

function inferProviderCode(name = "") {
  const normalized = String(name).toLowerCase();
  for (const [token, code] of Object.entries(PROVIDER_CODE_BY_NAME)) {
    if (normalized.includes(token)) return code;
  }
  return "";
}

function readIntegrationSchemaCode(configSchema = {}) {
  const direct = configSchema?.code;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (direct && typeof direct === "object") {
    const defaultValue = direct.default;
    if (typeof defaultValue === "string" && defaultValue.trim()) return defaultValue.trim();
  }
  return "";
}

function parseSettingValue(rawValue) {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object") return null;

    if (parsed.apiKeyEncrypted) {
      try {
        const decrypted = decryptSecret(parsed.apiKeyEncrypted);
        parsed.apiKey = maskSecret(decrypted);
      } catch {
        parsed.apiKey = "***";
      }
    }
    delete parsed.apiKeyEncrypted;

    return parsed;
  } catch {
    return null;
  }
}

function isPlatformAdmin(req) {
  return isPlatformAdminRole(req.user?.roleCanonical || req.user?.role);
}

function formatWorkspaceProvider(integrationRow) {
  let decrypted = {};
  try {
    decrypted = integrationRow?.encryptedConfig
      ? JSON.parse(decryptSecret(integrationRow.encryptedConfig))
      : {};
  } catch {
    decrypted = {};
  }

  let apiKey = null;
  if (decrypted.apiKeyEncrypted) {
    try {
      apiKey = maskSecret(decryptSecret(decrypted.apiKeyEncrypted));
    } catch {
      apiKey = "***";
    }
  } else if (decrypted.apiKey) {
    apiKey = maskSecret(String(decrypted.apiKey));
  }

  return {
    code: decrypted.code || readIntegrationSchemaCode(integrationRow.integrationType?.configSchema || {}) || inferProviderCode(integrationRow.integrationType?.name || ""),
    name: integrationRow.integrationType?.name || decrypted.name || "Provider",
    category: "ai_provider",
    model: decrypted.model || null,
    baseUrl: decrypted.baseUrl || null,
    host: decrypted.host || null,
    apiKey,
    source: "workspace_integration",
    integrationId: integrationRow.id,
    integrationTypeId: integrationRow.integrationTypeId,
    accessPolicy: {
      mode: integrationRow.accessMode || "workspace",
      allowedRoleIds: (() => {
        try {
          const parsed = JSON.parse(integrationRow.allowedRoleIds || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      allowedUserIds: (() => {
        try {
          const parsed = JSON.parse(integrationRow.allowedUserIds || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
    },
  };
}

/**
 * GET /api/ai-providers
 * Get all available IA providers
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const integrationProviders = await prisma.integrationType.findMany({
      where: {
        category: "ai_provider",
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        category: true
      },
    });

    if (integrationProviders.length > 0) {
      const enriched = await Promise.all(
        integrationProviders.map(async (provider) => {
          const full = await prisma.integrationType.findUnique({
            where: { id: provider.id },
            select: { configSchema: true },
          });
          const code = readIntegrationSchemaCode(full?.configSchema || {}) || inferProviderCode(provider.name);
          return {
            id: provider.id,
            integrationTypeId: provider.id,
            code,
            name: provider.name,
            category: provider.category,
            source: "integration_catalog",
          };
        })
      );

      return res.json({ providers: enriched });
    }

    // Legacy fallback
    const legacyProviders = await prisma.externalService.findMany({
      where: {
        OR: [{ category: "ia_cloud" }, { category: "ia_local" }],
        isActive: true,
      },
      select: {
        id: true,
        code: true,
        name: true,
        category: true,
      },
    });

    return res.json({ providers: legacyProviders });
  } catch (err) {
    console.error("[ai-providers] Get error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ai-providers/default
 * Get the default IA provider configured by admin
 */
router.get("/default", requireAuth, async (req, res) => {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: "default_ai_provider" }
    });

    if (!setting) {
      return res.json({ provider: null });
    }

    try {
      const config = JSON.parse(setting.value);

      // Decrypt and mask API key if present
      if (config.apiKeyEncrypted) {
        try {
          const decrypted = decryptSecret(config.apiKeyEncrypted);
          config.apiKey = maskSecret(decrypted);
        } catch {
          config.apiKey = "***";
        }
      }
      delete config.apiKeyEncrypted;

      return res.json({ provider: config });
    } catch {
      return res.json({ provider: null });
    }
  } catch (err) {
    console.error("[ai-providers] Get default error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai-providers/default
 * Set the default IA provider (admin only)
 */
const providerSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  // Accept both hyphen and underscore formats (frontend uses ia-cloud, Prisma uses ia_cloud)
  category: z.string().transform(v => v.replace(/-/g, "_")).pipe(z.enum(["ia_cloud", "ia_local", "ai_provider"])),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  baseUrl: z.string().url().optional(),
  host: z.string().url().optional(),
  capabilities: z.object({
    vision: z.boolean().optional(),
    audio: z.boolean().optional(),
    nativeDocuments: z.boolean().optional(),
  }).optional(),
});

router.post("/default", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const validated = providerSchema.parse(req.body);

    // Encrypt API key — if not provided (masked in UI), pull from ExternalService
    let apiKeyEncrypted = null;
    if (validated.apiKey) {
      apiKeyEncrypted = encryptSecret(validated.apiKey);
    } else {
      // Frontend couldn't send the key (it was masked as "***") — copy from ExternalService
      const svc = await prisma.externalService.findFirst({
        where: { code: validated.code, isActive: true },
        select: { defaultConfig: true }
      });
      if (svc?.defaultConfig) {
        const cfg = JSON.parse(svc.defaultConfig);
        if (cfg.apiKey && cfg._apiKeyEncrypted) {
          apiKeyEncrypted = cfg.apiKey; // already encrypted with same key — copy as-is
        } else if (cfg.apiKey) {
          apiKeyEncrypted = encryptSecret(cfg.apiKey);
        }
      }
    }

    // Save to system settings
    const providerJson = {
      code: validated.code,
      name: validated.name,
      category: validated.category,
      model: validated.model || null,
      baseUrl: validated.baseUrl || null,
      host: validated.host || null,
      apiKeyEncrypted,
      capabilities: validated.capabilities || null,
      setAt: new Date().toISOString()
    };

    await prisma.systemSetting.upsert({
      where: { key: "default_ai_provider" },
      update: { value: JSON.stringify(providerJson) },
      create: {
        key: "default_ai_provider",
        value: JSON.stringify({
          ...providerJson,
          setAt: new Date().toISOString()
        })
      }
    });

    return res.json({
      success: true,
      provider: validated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error("[ai-providers] Set default error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ai-providers/workspace/:workspaceId
 * Get the IA provider for a workspace (default or custom if plan permits)
 */
router.get("/workspace/:workspaceId", requireAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    if (!isPlatformAdmin(req) && req.user.workspaceId !== workspaceId) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const workspaceProvider = await prisma.workspaceIntegration.findFirst({
      where: {
        workspaceId,
        isEnabled: true,
        integrationType: {
          category: "ai_provider",
          isActive: true,
        },
      },
      include: {
        integrationType: true,
      },
      orderBy: { configuredAt: "desc" },
    });

    if (workspaceProvider) {
      return res.json({ provider: formatWorkspaceProvider(workspaceProvider) });
    }

    const defaultSetting = await prisma.systemSetting.findUnique({
      where: { key: "default_ai_provider" }
    });

    if (!defaultSetting) {
      return res.json({ provider: null });
    }

    return res.json({ provider: parseSettingValue(defaultSetting.value) });
  } catch (err) {
    console.error("[ai-providers] Get workspace error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai-providers/workspace/:workspaceId
 * Set custom IA provider for a workspace (requires ai_provider feature)
 */
const workspaceProviderSchema = providerSchema.extend({
  integrationTypeId: z.string().optional(),
});

router.post("/workspace/:workspaceId", requireAuth, requireRole("client", "admin"), async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const validated = workspaceProviderSchema.parse(req.body);

    if (!isPlatformAdmin(req) && req.user.workspaceId !== workspaceId) {
      return res.status(403).json({ error: "Not authorized" });
    }

    if (isPlatformAdmin(req) && !req.user.workspaceId) {
      return res.status(403).json({
        error: "Platform admin cannot configure workspace providers directly",
      });
    }

    let integrationType = null;
    if (validated.integrationTypeId) {
      integrationType = await prisma.integrationType.findFirst({
        where: {
          id: validated.integrationTypeId,
          category: "ai_provider",
          isActive: true,
        },
      });
    } else {
      integrationType = await prisma.integrationType.findFirst({
        where: {
          category: "ai_provider",
          isActive: true,
          OR: [
            { name: { contains: validated.name, mode: "insensitive" } },
            { name: { contains: validated.code, mode: "insensitive" } },
          ],
        },
      });
    }

    if (!integrationType) {
      return res.status(404).json({
        error: "No matching AI provider integration type found",
      });
    }

    // Encrypt API key if provided
    const apiKeyEncrypted = validated.apiKey ? encryptSecret(validated.apiKey) : null;

    const encryptedConfig = encryptSecret(JSON.stringify({
      code: validated.code,
      name: validated.name,
      category: "ai_provider",
      model: validated.model || null,
      baseUrl: validated.baseUrl || null,
      host: validated.host || null,
      apiKeyEncrypted,
    }));

    const workspaceProvider = await prisma.workspaceIntegration.upsert({
      where: {
        workspaceId_integrationTypeId: {
          workspaceId,
          integrationTypeId: integrationType.id,
        },
      },
      create: {
        workspaceId,
        integrationTypeId: integrationType.id,
        encryptedConfig,
        configuredByUserId: req.user.sub,
        isEnabled: true,
        accessMode: "workspace",
        allowedRoleIds: "[]",
        allowedUserIds: "[]",
      },
      update: {
        encryptedConfig,
        configuredByUserId: req.user.sub,
        isEnabled: true,
      },
      include: {
        integrationType: true,
      },
    });

    return res.json({
      success: true,
      provider: formatWorkspaceProvider(workspaceProvider)
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error("[ai-providers] Set workspace error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
