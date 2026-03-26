import express from "express";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole, requireFeature } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { encryptSecret, decryptSecret, maskSecret } from "../security/secrets.js";

const router = express.Router();

// ====== Admin Routes: IntegrationType CRUD ======

/**
 * GET /api/integrations
 * List all integration types
 * - Admin: all types
 * - Client/Sub-client: only active types
 */
router.get("/", requireAuth, requireWorkspaceContext, async (req, res) => {
  try {
    const where = req.user.role === "admin" ? {} : { isActive: true };
    const types = await prisma.integrationType.findMany({
      where,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        category: true,
        logoUrl: true,
        configSchema: true,
        isActive: true,
      },
    });

    res.json({ types });
  } catch (err) {
    console.error("[GET /integrations] Error:", err);
    res.status(500).json({ error: "Failed to list integration types" });
  }
});

/**
 * POST /api/integrations
 * Admin only: Create new integration type
 */
const createIntegrationTypeSchema = z.object({
  name: z.string().min(2).max(80),
  category: z.enum(["crm", "mail", "whatsapp", "calendar", "other"]),
  logoUrl: z.string().url().optional().or(z.literal("")),
  configSchema: z.record(z.any()).optional().default({}),
  isActive: z.boolean().optional().default(true),
});

router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const data = createIntegrationTypeSchema.parse(req.body);

    const type = await prisma.integrationType.create({
      data: {
        name: data.name,
        category: data.category,
        logoUrl: data.logoUrl || null,
        configSchema: data.configSchema,
        isActive: data.isActive,
      },
    });

    await logAudit(req.user.sub, "CREATE_INTEGRATION_TYPE", { typeId: type.id, name: type.name });

    res.status(201).json({ type });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    console.error("[POST /integrations] Error:", err);
    res.status(500).json({ error: "Failed to create integration type" });
  }
});

/**
 * PATCH /api/integrations/:id
 * Admin only: Update integration type
 */
const updateIntegrationTypeSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
  configSchema: z.record(z.any()).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const data = updateIntegrationTypeSchema.parse(req.body);

    const type = await prisma.integrationType.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl || null }),
        ...(data.configSchema !== undefined && { configSchema: data.configSchema }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });

    await logAudit(req.user.sub, "UPDATE_INTEGRATION_TYPE", { typeId: id });

    res.json({ type });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Integration type not found" });
    }
    console.error("[PATCH /integrations/:id] Error:", err);
    res.status(500).json({ error: "Failed to update integration type" });
  }
});

/**
 * DELETE /api/integrations/:id
 * Admin only: Soft delete (mark isActive = false)
 */
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;

    const type = await prisma.integrationType.update({
      where: { id },
      data: { isActive: false },
    });

    await logAudit(req.user.sub, "DELETE_INTEGRATION_TYPE", { typeId: id });

    res.json({ message: "Integration type deactivated", type });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Integration type not found" });
    }
    console.error("[DELETE /integrations/:id] Error:", err);
    res.status(500).json({ error: "Failed to delete integration type" });
  }
});

// ====== Workspace Integration Routes ======

/**
 * GET /api/workspaces/:id/integrations
 * Client: List enabled integrations for workspace
 */
router.get(
  "/workspace/:workspaceId",
  requireAuth,
  async (req, res) => {
    try {
      const { workspaceId } = req.params;

      // Verify workspace access
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      // Admil can see everything, others only their own workspace
      if (req.user.role !== "admin" && workspace.id !== req.user.workspaceId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const integrations = await prisma.workspaceIntegration.findMany({
        where: { workspaceId },
        include: { integrationType: true },
        orderBy: { integrationType: { name: "asc" } },
      });

      // Mask credentials/config
      const masked = integrations.map((int) => ({
        ...int,
        encryptedConfig: maskSecret(int.encryptedConfig),
      }));

      res.json({ integrations: masked });
    } catch (err) {
      console.error("[GET /workspace/:id/integrations] Error:", err);
      res.status(500).json({ error: "Failed to list workspace integrations" });
    }
  }
);

/**
 * POST /api/workspaces/:id/integrations
 * Client: Enable and configure integration for workspace
 */
const configureWorkspaceIntegrationSchema = z.object({
  integrationTypeId: z.string().min(1),
  config: z.record(z.any()),
});

router.post(
  "/workspace/:workspaceId",
  requireAuth,
  async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const data = configureWorkspaceIntegrationSchema.parse(req.body);

      // Verify workspace access
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      if (req.user.role !== "admin" && workspace.id !== req.user.workspaceId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Verify integration type exists
      const integrationType = await prisma.integrationType.findUnique({
        where: { id: data.integrationTypeId },
      });

      if (!integrationType) {
        return res.status(404).json({ error: "Integration type not found" });
      }

      // Encrypt config
      const encryptedConfig = encryptSecret(JSON.stringify(data.config));

      // Upsert: if already exists, update config
      const integration = await prisma.workspaceIntegration.upsert({
        where: { workspaceId_integrationTypeId: { workspaceId, integrationTypeId: data.integrationTypeId } },
        create: {
          workspaceId,
          integrationTypeId: data.integrationTypeId,
          encryptedConfig,
          configuredByUserId: req.user.sub,
          isEnabled: true,
        },
        update: {
          encryptedConfig,
          configuredByUserId: req.user.sub,
          isEnabled: true,
        },
        include: { integrationType: true },
      });

      await logAudit(req.user.sub, "CONFIGURE_WORKSPACE_INTEGRATION", {
        workspaceId,
        integrationTypeId: data.integrationTypeId,
      });

      // Mask credentials
      const masked = { ...integration, encryptedConfig: maskSecret(integration.encryptedConfig) };

      res.status(201).json({ integration: masked });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", issues: err.errors });
      }
      console.error("[POST /workspace/:id/integrations] Error:", err);
      res.status(500).json({ error: "Failed to configure integration" });
    }
  }
);

/**
 * PATCH /api/workspaces/:id/integrations/:iid
 * Client: Update config or toggle isEnabled
 */
const updateWorkspaceIntegrationSchema = z.object({
  config: z.record(z.any()).optional(),
  isEnabled: z.boolean().optional(),
});

router.patch(
  "/workspace/:workspaceId/:integrationId",
  requireAuth,
  requireWorkspaceContext,
  requireFeature("external_connections"),
  async (req, res) => {
    try {
      const { workspaceId, integrationId } = req.params;
      const data = updateWorkspaceIntegrationSchema.parse(req.body);

      // Verify workspace access
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      if (req.user.role !== "admin" && workspace.id !== req.user.workspaceId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const updateData = {};

      if (data.config) {
        updateData.encryptedConfig = encryptSecret(JSON.stringify(data.config));
      }

      if (data.isEnabled !== undefined) {
        updateData.isEnabled = data.isEnabled;
      }

      const integration = await prisma.workspaceIntegration.update({
        where: { id: integrationId },
        data: updateData,
        include: { integrationType: true },
      });

      await logAudit(req.user.sub, "UPDATE_WORKSPACE_INTEGRATION", { workspaceId, integrationId });

      const masked = { ...integration, encryptedConfig: maskSecret(integration.encryptedConfig) };
      res.json({ integration: masked });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", issues: err.errors });
      }
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Integration not found" });
      }
      console.error("[PATCH /workspace/:id/integrations/:iid] Error:", err);
      res.status(500).json({ error: "Failed to update integration" });
    }
  }
);

/**
 * DELETE /api/workspaces/:id/integrations/:iid
 * Client: Remove integration from workspace
 */
router.delete(
  "/workspace/:workspaceId/:integrationId",
  requireAuth,
  requireWorkspaceContext,
  requireFeature("external_connections"),
  async (req, res) => {
    try {
      const { workspaceId, integrationId } = req.params;

      // Verify workspace access
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      if (req.user.role !== "admin" && workspace.id !== req.user.workspaceId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      await prisma.workspaceIntegration.delete({
        where: { id: integrationId },
      });

      await logAudit(req.user.sub, "DELETE_WORKSPACE_INTEGRATION", { workspaceId, integrationId });

      res.json({ message: "Integration removed from workspace" });
    } catch (err) {
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Integration not found" });
      }
      console.error("[DELETE /workspace/:id/integrations/:iid] Error:", err);
      res.status(500).json({ error: "Failed to delete integration" });
    }
  }
);

// ====== User Personal Integration Routes ======

/**
 * GET /api/users/me/integrations
 * User: List personal integrations (WhatsApp, Email, Calendar, etc.)
 */
router.get(
  "/me",
  requireAuth,
  requireWorkspaceContext,
  requireFeature("external_connections"),
  async (req, res) => {
    try {
      const integrations = await prisma.userIntegration.findMany({
        where: { userId: req.user.sub },
        include: { integrationType: true },
        orderBy: { integrationType: { name: "asc" } },
      });

      // Mask credentials
      const masked = integrations.map((int) => ({
        ...int,
        encryptedCredentials: maskSecret(int.encryptedCredentials),
      }));

      res.json({ integrations: masked });
    } catch (err) {
      console.error("[GET /users/me/integrations] Error:", err);
      res.status(500).json({ error: "Failed to list personal integrations" });
    }
  }
);

/**
 * POST /api/users/me/integrations
 * User: Link personal account (WhatsApp, email, calendar)
 */
const linkUserIntegrationSchema = z.object({
  integrationTypeId: z.string().min(1),
  credentials: z.record(z.any()),
});

router.post(
  "/me",
  requireAuth,
  requireWorkspaceContext,
  requireFeature("external_connections"),
  async (req, res) => {
    try {
      const data = linkUserIntegrationSchema.parse(req.body);

      // Verify integration type exists
      const integrationType = await prisma.integrationType.findUnique({
        where: { id: data.integrationTypeId },
      });

      if (!integrationType) {
        return res.status(404).json({ error: "Integration type not found" });
      }

      // Encrypt credentials
      const encryptedCredentials = encryptSecret(JSON.stringify(data.credentials));

      // Upsert
      const integration = await prisma.userIntegration.upsert({
        where: { userId_integrationTypeId: { userId: req.user.sub, integrationTypeId: data.integrationTypeId } },
        create: {
          userId: req.user.sub,
          integrationTypeId: data.integrationTypeId,
          encryptedCredentials,
        },
        update: {
          encryptedCredentials,
        },
        include: { integrationType: true },
      });

      await logAudit(req.user.sub, "LINK_USER_INTEGRATION", { integrationTypeId: data.integrationTypeId });

      const masked = { ...integration, encryptedCredentials: maskSecret(integration.encryptedCredentials) };
      res.status(201).json({ integration: masked });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", issues: err.errors });
      }
      console.error("[POST /users/me/integrations] Error:", err);
      res.status(500).json({ error: "Failed to link integration" });
    }
  }
);

/**
 * DELETE /api/users/me/integrations/:id
 * User: Unlink personal integration
 */
router.delete(
  "/me/:id",
  requireAuth,
  requireWorkspaceContext,
  requireFeature("external_connections"),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Verify ownership
      const integration = await prisma.userIntegration.findUnique({
        where: { id },
        select: { userId: true },
      });

      if (!integration) {
        return res.status(404).json({ error: "Integration not found" });
      }

      if (integration.userId !== req.user.sub && req.user.role !== "admin") {
        return res.status(403).json({ error: "Not authorized" });
      }

      await prisma.userIntegration.delete({
        where: { id },
      });

      await logAudit(req.user.sub, "UNLINK_USER_INTEGRATION", { integrationId: id });

      res.json({ message: "Integration unlinked" });
    } catch (err) {
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Integration not found" });
      }
      console.error("[DELETE /users/me/integrations/:id] Error:", err);
      res.status(500).json({ error: "Failed to unlink integration" });
    }
  }
);

// ====== Admin seed route (for bootstrap) ======

/**
 * POST /api/integrations/seed
 * Admin only: Insert default integration types if they don't exist
 */
router.post("/seed", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const defaultTypes = [
      // CRM
      {
        name: "Sellsy",
        category: "crm",
        logoUrl: "https://sellsy.com/images/logo.svg",
        configSchema: { token: { type: "string" }, apiUrl: { type: "string" } },
      },
      {
        name: "HubSpot",
        category: "crm",
        logoUrl: "https://www.hubspot.com/logo.svg",
        configSchema: { apiKey: { type: "string" } },
      },
      {
        name: "Pipedrive",
        category: "crm",
        logoUrl: "https://www.pipedrive.com/logo.svg",
        configSchema: { apiKey: { type: "string" }, companyDomain: { type: "string" } },
      },
      // Mail
      {
        name: "Gmail SMTP",
        category: "mail",
        logoUrl: "https://www.google.com/favicon.ico",
        configSchema: {
          email: { type: "string" },
          password: { type: "string" },
          smtpServer: { type: "string", default: "smtp.gmail.com" },
          port: { type: "number", default: 587 },
        },
      },
      {
        name: "SendGrid",
        category: "mail",
        logoUrl: "https://www.sendgrid.com/favicon.ico",
        configSchema: { apiKey: { type: "string" } },
      },
      {
        name: "SMTP Custom",
        category: "mail",
        logoUrl: null,
        configSchema: {
          smtpServer: { type: "string" },
          port: { type: "number" },
          email: { type: "string" },
          password: { type: "string" },
        },
      },
      // WhatsApp
      {
        name: "Meta Business WhatsApp",
        category: "whatsapp",
        logoUrl: "https://www.whatsapp.com/favicon.ico",
        configSchema: {
          businessAccountId: { type: "string" },
          accessToken: { type: "string" },
          phoneNumber: { type: "string" },
        },
      },
      {
        name: "Twilio WhatsApp",
        category: "whatsapp",
        logoUrl: "https://www.twilio.com/favicon.ico",
        configSchema: {
          accountSid: { type: "string" },
          authToken: { type: "string" },
          twilioPhoneNumber: { type: "string" },
        },
      },
      // Calendar
      {
        name: "Google Calendar",
        category: "calendar",
        logoUrl: "https://www.google.com/favicon.ico",
        configSchema: {
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          refreshToken: { type: "string" },
        },
      },
      {
        name: "Outlook Calendar",
        category: "calendar",
        logoUrl: "https://www.microsoft.com/favicon.ico",
        configSchema: {
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          refreshToken: { type: "string" },
        },
      },
      {
        name: "CalDAV",
        category: "calendar",
        logoUrl: null,
        configSchema: {
          url: { type: "string" },
          username: { type: "string" },
          password: { type: "string" },
        },
      },
      // Other
      {
        name: "Webhook",
        category: "other",
        logoUrl: null,
        configSchema: {
          url: { type: "string" },
          secret: { type: "string" },
        },
      },
      {
        name: "Custom API",
        category: "other",
        logoUrl: null,
        configSchema: {
          baseUrl: { type: "string" },
          apiKey: { type: "string" },
        },
      },
    ];

    const created = [];

    for (const typeData of defaultTypes) {
      const existing = await prisma.integrationType.findFirst({
        where: { name: typeData.name },
      });

      if (!existing) {
        const type = await prisma.integrationType.create({ data: typeData });
        created.push(type);
      }
    }

    res.json({
      message: `Seeded ${created.length} integration types`,
      created,
    });
  } catch (err) {
    console.error("[POST /seed] Error:", err);
    res.status(500).json({ error: "Failed to seed integration types" });
  }
});

export default router;
