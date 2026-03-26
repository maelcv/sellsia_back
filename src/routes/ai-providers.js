import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { encryptSecret, decryptSecret, maskSecret } from "../security/secrets.js";

const router = Router();

/**
 * GET /api/ai-providers
 * Get all available IA providers
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    // Get all ExternalService of category 'ia_cloud' or 'ia_local'
    const providers = await prisma.externalService.findMany({
      where: {
        OR: [
          { category: "ia_cloud" },
          { category: "ia_local" }
        ],
        isActive: true
      },
      select: {
        id: true,
        code: true,
        name: true,
        category: true
      }
    });

    return res.json({ providers });
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
  category: z.string().transform(v => v.replace(/-/g, "_")).pipe(z.enum(["ia_cloud", "ia_local"])),
  apiKey: z.string().optional()
});

router.post("/default", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const validated = providerSchema.parse(req.body);

    // Encrypt API key if provided
    const apiKeyEncrypted = validated.apiKey ? encryptSecret(validated.apiKey) : null;

    // Save to system settings
    await prisma.systemSetting.upsert({
      where: { key: "default_ai_provider" },
      update: {
        value: JSON.stringify({
          code: validated.code,
          name: validated.name,
          category: validated.category,
          apiKeyEncrypted,
          setAt: new Date().toISOString()
        })
      },
      create: {
        key: "default_ai_provider",
        value: JSON.stringify({
          code: validated.code,
          name: validated.name,
          category: validated.category,
          apiKeyEncrypted,
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

    // Check if workspace has custom provider (stored in workspace table)
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { customAiProvider: true }
    });

    if (workspace?.customAiProvider) {
      try {
        const config = JSON.parse(workspace.customAiProvider);
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
        // Fall through to default
      }
    }

    // Otherwise return default provider
    const defaultSetting = await prisma.systemSetting.findUnique({
      where: { key: "default_ai_provider" }
    });

    if (!defaultSetting) {
      return res.json({ provider: null });
    }

    try {
      const config = JSON.parse(defaultSetting.value);
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
    console.error("[ai-providers] Get workspace error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai-providers/workspace/:workspaceId
 * Set custom IA provider for a workspace (requires ai_provider feature)
 */
router.post("/workspace/:workspaceId", requireAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const validated = providerSchema.parse(req.body);

    // Encrypt API key if provided
    const apiKeyEncrypted = validated.apiKey ? encryptSecret(validated.apiKey) : null;

    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        customAiProvider: JSON.stringify({
          code: validated.code,
          name: validated.name,
          category: validated.category,
          apiKeyEncrypted
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
    console.error("[ai-providers] Set workspace error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
