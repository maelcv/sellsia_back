/**
 * Sub-Agents & Tools Management Routes
 *
 * Provides full CRUD for SubAgentDefinition:
 *   - Admins manage global sub-agents (workspaceId = null)
 *   - Clients with "custom_agent" feature manage workspace-scoped sub-agents
 *
 * Security:
 *   - All reads are workspace-isolated (client sees own + global)
 *   - Writes enforce workspace ownership
 *   - Admin bypass for platform-level definitions
 */

import { Router } from "express";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, isPlatformAdminRole } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";

const router = Router();

// Available built-in capabilities a sub-agent/tool can have
// ⚠️  Ajouter une clé ici suffit pour qu'elle soit disponible dans l'interface.
//     Ne jamais supprimer une clé existante (backward-compat des sub-agents enregistrés).
export const BUILTIN_CAPABILITIES = [
  // ── CRM ───────────────────────────────────────────────────────────────────
  { key: "crm_sellsy_read",      label: "Lire le CRM Sellsy",                category: "crm" },
  { key: "crm_sellsy_write",     label: "Modifier le CRM Sellsy",             category: "crm" },
  { key: "crm_salesforce_read",  label: "Lire le CRM Salesforce",             category: "crm" },
  { key: "crm_salesforce_write", label: "Modifier le CRM Salesforce",         category: "crm" },
  { key: "pipeline_analyze",     label: "Analyser le pipeline commercial",     category: "crm" },
  // ── Web ────────────────────────────────────────────────────────────────────
  { key: "web_search",           label: "Recherche web (Tavily)",              category: "web" },
  { key: "web_scrape",           label: "Scraping & analyse de pages web",     category: "web" },
  // ── Files ──────────────────────────────────────────────────────────────────
  { key: "file_office_read",     label: "Lire documents Office / OpenDocument", category: "files" },
  { key: "file_office_write",    label: "Générer documents Office / OpenDocument", category: "files" },
  { key: "file_pdf_read",        label: "Lire des PDF",                        category: "files" },
  { key: "file_pdf_write",       label: "Générer des PDF",                     category: "files" },
  { key: "image_ocr",            label: "OCR — lecture et analyse d'images",   category: "files" },
  // ── Knowledge ──────────────────────────────────────────────────────────────
  { key: "knowledge_cache",      label: "Cache — réutilisation de réponses",   category: "knowledge" },
  { key: "knowledge_sort",       label: "Tri et optimisation de la base de connaissance", category: "knowledge" },
  { key: "content_write",        label: "Rédaction de contenus commerciaux",     category: "content" },
  { key: "content_classify_backlinks", label: "Classification de contenus + backlinks Vault", category: "content" },
  { key: "user_profile_learning", label: "Apprentissage du profil utilisateur",  category: "learning" },
  // ── Communication ──────────────────────────────────────────────────────────
  { key: "email_read",           label: "Lire et chercher des emails",         category: "communication" },
  { key: "email_send",           label: "Rédiger et envoyer des emails",       category: "communication" },
  { key: "calendar_read",        label: "Lire les événements calendrier",      category: "communication" },
  { key: "calendar_write",       label: "Créer/modifier des événements calendrier", category: "communication" },
  // ── Admin (accès réservé admin) ────────────────────────────────────────────
  { key: "admin_platform",       label: "Analyse plateforme (admin uniquement)", category: "admin" },
];

const createSubAgentSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().min(8).max(500),
  subAgentType: z.enum(["tool", "sub_agent"]).default("sub_agent"),
  systemPrompt: z.string().max(20000).optional(),
  capabilities: z.array(z.string()).default([]),
  defaultProviderCode: z.string().max(64).optional(),
  defaultModel: z.string().max(128).optional(),
  isActive: z.boolean().default(true),
});

const updateSubAgentSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().min(8).max(500).optional(),
  systemPrompt: z.string().max(20000).optional(),
  capabilities: z.array(z.string()).optional(),
  defaultProviderCode: z.string().max(64).optional(),
  defaultModel: z.string().max(128).optional(),
  isActive: z.boolean().optional(),
});

const DEFAULT_SUB_AGENT_PRESETS = [
  {
    name: "Content Writer",
    description: "Rédige des contenus commerciaux structurés et orientés conversion.",
    subAgentType: "sub_agent",
    systemPrompt: "You are a sales content specialist. Produce concise, action-oriented copy aligned with the workspace tone and business context.",
    capabilities: ["content_write", "web_search"],
  },
  {
    name: "Content Classifier",
    description: "Classe les contenus et génère des backlinks contextuels vers le Vault.",
    subAgentType: "sub_agent",
    systemPrompt: "You classify incoming content by topic, intent and confidence, then suggest explicit Vault backlink references to related notes.",
    capabilities: ["content_classify_backlinks", "knowledge_sort", "knowledge_cache"],
  },
  {
    name: "User Profile Learner",
    description: "Extrait et consolide les préférences utilisateur depuis les conversations.",
    subAgentType: "sub_agent",
    systemPrompt: "You infer user preferences and communication style from conversation history and summarize stable profile traits for future personalization.",
    capabilities: ["user_profile_learning", "knowledge_cache"],
  },
];

/**
 * Seeds default sub-agent presets for a workspace (idempotent).
 * Called automatically on workspace creation.
 */
export async function seedSubAgentsForWorkspace(prismaClient, workspaceId, ownerId) {
  for (const preset of DEFAULT_SUB_AGENT_PRESETS) {
    const existing = await prismaClient.subAgentDefinition.findFirst({
      where: { name: preset.name, workspaceId },
      select: { id: true },
    });
    if (existing) continue;
    await prismaClient.subAgentDefinition.create({
      data: {
        name: preset.name,
        description: preset.description,
        subAgentType: preset.subAgentType,
        systemPrompt: preset.systemPrompt,
        capabilities: JSON.stringify(preset.capabilities),
        workspaceId,
        ownerId,
        isActive: true,
      },
    });
  }
}

/**
 * GET /api/sub-agents/capabilities
 * Returns the list of available built-in capabilities
 */
router.get("/capabilities", requireAuth, (_req, res) => {
  return res.json({ capabilities: BUILTIN_CAPABILITIES });
});

router.post("/seed-presets", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const isAdmin = isPlatformAdminRole(req.user?.roleCanonical || req.user?.role);
    const targetWorkspaceId = isAdmin ? (String(req.query.workspaceId || "").trim() || null) : req.workspaceId;

    if (!isAdmin) {
      const perms = req.workspacePlan?.permissions || {};
      if (!perms.custom_agent) {
        return res.status(403).json({ error: "Votre plan ne permet pas de créer des sous-agents personnalisés." });
      }
    }

    const created = [];
    const skipped = [];

    for (const preset of DEFAULT_SUB_AGENT_PRESETS) {
      const existing = await prisma.subAgentDefinition.findFirst({
        where: {
          name: preset.name,
          workspaceId: targetWorkspaceId,
        },
        select: { id: true },
      });

      if (existing) {
        skipped.push(preset.name);
        continue;
      }

      const subAgent = await prisma.subAgentDefinition.create({
        data: {
          name: preset.name,
          description: preset.description,
          subAgentType: preset.subAgentType,
          systemPrompt: preset.systemPrompt,
          capabilities: JSON.stringify(preset.capabilities),
          workspaceId: targetWorkspaceId,
          ownerId: req.user.sub,
          isActive: true,
        },
      });

      created.push(subAgent.id);
    }

    await logAudit(req.user.sub, "SUB_AGENT_PRESETS_SEEDED", {
      workspaceId: targetWorkspaceId,
      createdCount: created.length,
      skippedCount: skipped.length,
    });

    return res.json({
      success: true,
      workspaceId: targetWorkspaceId,
      createdCount: created.length,
      skipped,
    });
  } catch (err) {
    console.error("[sub-agents] seed presets error:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /api/sub-agents
 * List sub-agents visible to the current user:
 *   - Admin: all global (workspaceId=null) + optionally filter by workspace
 *   - Client: global + own workspace sub-agents
 */
router.get("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";

    const whereClause = isAdmin
      ? {} // Admin sees everything
      : {
          isActive: true,
          OR: [
            { workspaceId: null },           // Global platform sub-agents
            { workspaceId: req.workspaceId }, // Own workspace sub-agents
          ],
        };

    const subAgents = await prisma.subAgentDefinition.findMany({
      where: whereClause,
      orderBy: [{ workspaceId: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        subAgentType: true,
        systemPrompt: true,
        capabilities: true,
        defaultProviderCode: true,
        defaultModel: true,
        isActive: true,
        workspaceId: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const formatted = subAgents.map((sa) => ({
      ...sa,
      capabilities: safeParseJson(sa.capabilities, []),
      isGlobal: !sa.workspaceId,
    }));

    return res.json({ subAgents: formatted });
  } catch (err) {
    console.error("[sub-agents] List error:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /api/sub-agents/:id
 * Get a single sub-agent definition
 */
router.get("/:id", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const sa = await prisma.subAgentDefinition.findUnique({
      where: { id: req.params.id },
    });

    if (!sa) return res.status(404).json({ error: "Sous-agent introuvable" });

    // Non-admin: can only see global or own workspace
    if (req.user.role !== "admin" && sa.workspaceId && sa.workspaceId !== req.workspaceId) {
      return res.status(404).json({ error: "Sous-agent introuvable" });
    }

    return res.json({
      subAgent: {
        ...sa,
        capabilities: safeParseJson(sa.capabilities, []),
        isGlobal: !sa.workspaceId,
      },
    });
  } catch (err) {
    console.error("[sub-agents] Get error:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * POST /api/sub-agents
 * Create a sub-agent:
 *   - Admin → creates global (workspaceId=null)
 *   - Client with "custom_agent" → creates workspace-scoped
 */
router.post(
  "/",
  requireAuth,
  requireWorkspaceContext,
  async (req, res) => {
    const isAdmin = req.user.role === "admin";

    // Non-admins need the custom_agent feature
    if (!isAdmin) {
      const perms = req.workspacePlan?.permissions || {};
      if (!perms.custom_agent) {
        return res.status(403).json({
          error: "Votre plan ne permet pas de créer des sous-agents personnalisés.",
        });
      }
    }

    const parse = createSubAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    const { name, description, subAgentType, systemPrompt, capabilities, isActive } = parse.data;
    const { defaultProviderCode, defaultModel } = parse.data;

    // Validate capabilities against known list (prevent injection)
    const validKeys = new Set(BUILTIN_CAPABILITIES.map((c) => c.key));
    const sanitizedCapabilities = capabilities.filter((c) => validKeys.has(c));

    try {
      const sa = await prisma.subAgentDefinition.create({
        data: {
          name,
          description,
          subAgentType,
          systemPrompt: systemPrompt || null,
          capabilities: JSON.stringify(sanitizedCapabilities),
          defaultProviderCode: defaultProviderCode || null,
          defaultModel: defaultModel || null,
          isActive,
          workspaceId: isAdmin ? null : req.workspaceId,
          ownerId: req.user.sub,
        },
      });

      await logAudit(req.user.sub, "SUB_AGENT_CREATED", {
        subAgentId: sa.id,
        workspaceId: sa.workspaceId,
      });

      return res.status(201).json({
        success: true,
        subAgent: { ...sa, capabilities: sanitizedCapabilities, isGlobal: !sa.workspaceId },
      });
    } catch (err) {
      console.error("[sub-agents] Create error:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/**
 * PATCH /api/sub-agents/:id
 * Update a sub-agent (admin for global, owner for workspace-scoped)
 */
router.patch(
  "/:id",
  requireAuth,
  requireWorkspaceContext,
  async (req, res) => {
    const parse = updateSubAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Données invalides", details: parse.error.flatten() });
    }

    try {
      const sa = await prisma.subAgentDefinition.findUnique({ where: { id: req.params.id } });
      if (!sa) return res.status(404).json({ error: "Sous-agent introuvable" });

      // Permission check
      if (req.user.role !== "admin") {
        if (!sa.workspaceId || sa.workspaceId !== req.workspaceId) {
          return res.status(403).json({ error: "Modification non autorisée" });
        }
      }

      const {
        name,
        description,
        systemPrompt,
        capabilities,
        defaultProviderCode,
        defaultModel,
        isActive,
      } = parse.data;

      let sanitizedCapabilities;
      if (capabilities !== undefined) {
        const validKeys = new Set(BUILTIN_CAPABILITIES.map((c) => c.key));
        sanitizedCapabilities = capabilities.filter((c) => validKeys.has(c));
      }

      const updated = await prisma.subAgentDefinition.update({
        where: { id: req.params.id },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(systemPrompt !== undefined && { systemPrompt }),
          ...(sanitizedCapabilities !== undefined && { capabilities: JSON.stringify(sanitizedCapabilities) }),
          ...(defaultProviderCode !== undefined && { defaultProviderCode: defaultProviderCode || null }),
          ...(defaultModel !== undefined && { defaultModel: defaultModel || null }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      await logAudit(req.user.sub, "SUB_AGENT_UPDATED", { subAgentId: sa.id });

      return res.json({
        success: true,
        subAgent: {
          ...updated,
          capabilities: safeParseJson(updated.capabilities, []),
          isGlobal: !updated.workspaceId,
        },
      });
    } catch (err) {
      console.error("[sub-agents] Update error:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/**
 * DELETE /api/sub-agents/:id
 * Delete a sub-agent (admin for global, owner for workspace-scoped)
 */
router.delete(
  "/:id",
  requireAuth,
  requireWorkspaceContext,
  async (req, res) => {
    try {
      const sa = await prisma.subAgentDefinition.findUnique({ where: { id: req.params.id } });
      if (!sa) return res.status(404).json({ error: "Sous-agent introuvable" });

      if (req.user.role !== "admin") {
        if (!sa.workspaceId || sa.workspaceId !== req.workspaceId) {
          return res.status(403).json({ error: "Suppression non autorisée" });
        }
      }

      await prisma.subAgentDefinition.delete({ where: { id: req.params.id } });
      await logAudit(req.user.sub, "SUB_AGENT_DELETED", { subAgentId: sa.id });

      return res.json({ success: true });
    } catch (err) {
      console.error("[sub-agents] Delete error:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export default router;
