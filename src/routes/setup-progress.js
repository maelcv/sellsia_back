import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/setup/progress
 * Returns current setup completion status for admin dashboard
 *
 * Steps:
 * 1. DB connected (always true if endpoint responds)
 * 2. Email configured (systemSetting: system_smtp_config)
 * 3. Admin exists (count of admin users)
 * 4. Default IA provider configured (systemSetting: default_ai_provider exists)
 * 5. At least 1 agent created (excluding 'admin' agent, only Commercial/Director/Technical)
 * 6. At least 1 client with workspace created (workspaces with parentWorkspaceId = null and != admin workspace)
 */
router.get("/progress", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const [
      emailConfigSetting,
      adminCount,
      providerSetting,
      agentCount,
      workspaceCount,
      clientCount
    ] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: "system_smtp_config" } }),
      prisma.user.count({ where: { role: "admin" } }),
      prisma.systemSetting.findUnique({ where: { key: "default_ai_provider" } }),
      // Count agents excluding the 'admin' agent (Commercial, Director, Technical only)
      prisma.agent.count({
        where: {
          isActive: true,
          NOT: { id: "agent-admin" } // Exclude admin agent
        }
      }),
      // Count root workspaces (clients)
      prisma.workspace.count({
        where: {
          status: "active",
          parentWorkspaceId: null
        }
      }),
      // Count client users (role = 'client')
      prisma.user.count({
        where: {
          role: "client"
        }
      })
    ]);

    // Log detailed info for debugging
    console.log("[setup-progress] Debug:", {
      emailConfig: {
        exists: !!emailConfigSetting,
        key: emailConfigSetting?.key
      },
      adminCount,
      providerSetting: {
        exists: !!providerSetting,
        key: providerSetting?.key,
        value: providerSetting?.value ? "SET" : "NULL"
      },
      agentCount,
      workspaceCount,
      clientCount
    });

    const steps = [
      {
        id: 1,
        title: "Base de Données",
        description: "PostgreSQL connecté",
        completed: true // Always true if this endpoint responds
      },
      {
        id: 2,
        title: "Configuration Email",
        description: "SMTP configuré et testé",
        completed: !!emailConfigSetting
      },
      {
        id: 3,
        title: "Admin Créé",
        description: "Compte administrateur",
        completed: adminCount > 0
      },
      {
        id: 4,
        title: "Provider IA",
        description: "Provider par défaut défini",
        completed: !!providerSetting
      },
      {
        id: 5,
        title: "Premier Agent",
        description: "Au moins 1 agent créé (Commercial, Director, Technical)",
        completed: agentCount > 0
      },
      {
        id: 6,
        title: "Premier Client",
        description: "Client avec workspace créé",
        completed: clientCount > 0
      }
    ];

    const completedCount = steps.filter(s => s.completed).length;
    const progressPercent = (completedCount / steps.length) * 100;

    return res.json({
      steps,
      completedCount,
      totalSteps: steps.length,
      progressPercent,
      isComplete: completedCount === steps.length
    });
  } catch (err) {
    console.error("[setup-progress] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/setup/debug
 * Debug endpoint to check actual data in database
 * Admin only
 */
router.get("/debug", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const [
      emailSettings,
      allUsers,
      allAdmins,
      allClients,
      providerSettings,
      allAgents,
      allWorkspaces,
      activeWorkspaces
    ] = await Promise.all([
      prisma.systemSetting.findMany({ where: { key: "system_smtp_config" } }),
      prisma.user.findMany({ select: { id: true, email: true, role: true } }),
      prisma.user.findMany({ where: { role: "admin" }, select: { id: true, email: true } }),
      prisma.user.findMany({ where: { role: "client" }, select: { id: true, email: true, workspaceId: true } }),
      prisma.systemSetting.findMany({ where: { key: "default_ai_provider" } }),
      prisma.agent.findMany({ select: { id: true, name: true, isActive: true } }),
      prisma.workspace.findMany({ select: { id: true, name: true, status: true, parentWorkspaceId: true } }),
      prisma.workspace.findMany({ where: { status: "active", parentWorkspaceId: null }, select: { id: true, name: true } })
    ]);

    return res.json({
      emailConfig: {
        exists: emailSettings.length > 0,
        count: emailSettings.length
      },
      users: {
        total: allUsers.length,
        byRole: {
          admin: allAdmins.length,
          client: allClients.length,
          other: allUsers.length - allAdmins.length - allClients.length
        },
        admins: allAdmins,
        clients: allClients
      },
      provider: {
        exists: providerSettings.length > 0,
        count: providerSettings.length
      },
      agents: {
        total: allAgents.length,
        active: allAgents.filter(a => a.isActive).length,
        list: allAgents
      },
      workspaces: {
        total: allWorkspaces.length,
        active: activeWorkspaces.length,
        rootWorkspaces: activeWorkspaces,
        allWorkspaces
      }
    });
  } catch (err) {
    console.error("[setup-progress-debug] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
