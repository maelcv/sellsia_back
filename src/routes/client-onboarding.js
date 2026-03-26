import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import multer from "multer";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { sendEmail } from "../../ia_models/email/email-service.js";
import { encryptSecret } from "../security/secrets.js";

const router = Router();

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max per file
});

/**
 * POST /api/onboarding/client
 * Complete client onboarding (admin creates client + workspace + team + knowledge)
 *
 * Step 1: Client info
 * Step 2: Workspace details
 * Step 3: Team members (CSV or manual email list)
 * Step 4: Organizational data upload (files)
 * Step 5: Knowledge upload (files)
 * Step 6: Summary + send invitations
 */

const clientInfoSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  companyName: z.string().min(1)
});

const workspaceSchema = z.object({
  workspaceName: z.string().min(1),
  workspaceDescription: z.string().optional(),
  industry: z.string().optional(),
  teamSize: z.string().optional()
});

const teamSchema = z.object({
  members: z.array(z.object({
    email: z.string().email(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    role: z.enum(["admin", "user"])
  }))
});

const knowledgeSchema = z.object({
  orgChart: z.string().optional(), // Base64 or file content
  processes: z.string().optional(),
  clientData: z.string().optional(),
  additionalDocs: z.array(z.object({
    title: z.string(),
    content: z.string()
  })).optional()
});

/**
 * POST /api/onboarding/client/validate-step-1
 * Validate client info (email uniqueness)
 */
router.post("/client/validate-step-1", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { email } = clientInfoSchema.parse(req.body);

    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (existingUser) {
      return res.status(400).json({
        error: "Email already exists",
        field: "email"
      });
    }

    return res.json({ valid: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/onboarding/client/create
 * Create client + workspace + team + knowledge in one transaction
 */
router.post("/client/create", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const {
      clientInfo,
      workspace: workspaceData,
      team,
      knowledge,
      planId,
      newPlan
    } = req.body;

    // Validate all inputs
    const validatedClient = clientInfoSchema.parse(clientInfo);
    const validatedWorkspace = workspaceSchema.parse(workspaceData);
    const validatedTeam = teamSchema.parse(team || { members: [] });
    const validatedKnowledge = knowledgeSchema.parse(knowledge || {});

    // Transaction for atomicity
    const result = await prisma.$transaction(async (tx) => {
      // 0. Create or resolve plan
      let finalPlanId = planId ? Number(planId) : null;

      if (newPlan) {
        const createdPlan = await tx.plan.create({
          data: {
            name: newPlan.name,
            monthlyTokenLimit: newPlan.monthlyTokenLimit || 100000,
            collaboratorLimit: newPlan.maxUsers || 10,
            priceEurMonth: newPlan.priceEurMonth || 0,
            featuresJson: JSON.stringify(
              Object.entries(newPlan.permissions || {})
                .filter(([_, v]) => v)
                .map(([k]) => k)
            ),
            permissionsJson: JSON.stringify(newPlan.permissions || {}),
            maxSubClients: newPlan.maxSubClients || 0,
            maxUsers: newPlan.maxUsers || 10,
            maxAgents: newPlan.maxAgents || 5,
            isActive: true,
          }
        });
        finalPlanId = createdPlan.id;
      }

      // 1. Create workspace
      const workspaceName = validatedWorkspace.workspaceName;
      const slug = await generateUniqueSlug(workspaceName, tx);

      const newWorkspace = await tx.workspace.create({
        data: {
          name: workspaceName,
          slug,
          status: "active",
          plan: "professional", // Default to professional plan for new clients
          ...(finalPlanId ? { planId: finalPlanId } : {})
        }
      });

      // 2. Create client user
      const passwordHash = bcrypt.hashSync(Math.random().toString(36).slice(-10), 12);
      const clientUser = await tx.user.create({
        data: {
          email: validatedClient.email.toLowerCase(),
          passwordHash,
          role: "client",
          companyName: validatedClient.companyName,
          workspaceId: newWorkspace.id
        }
      });

      // 3. Create team members
      const teamMembers = [];
      for (const member of validatedTeam.members) {
        const memberPassword = Math.random().toString(36).slice(-10);
        const memberHash = bcrypt.hashSync(memberPassword, 12);

        const teamMember = await tx.user.create({
          data: {
            email: member.email.toLowerCase(),
            passwordHash: memberHash,
            role: "sub_client",
            companyName: validatedClient.companyName,
            workspaceId: newWorkspace.id
          }
        });

        teamMembers.push({
          user: teamMember,
          tempPassword: memberPassword
        });
      }

      // 4. Create knowledge documents
      if (validatedKnowledge.orgChart) {
        await tx.knowledgeDocument.create({
          data: {
            title: "Organigramme",
            content: validatedKnowledge.orgChart,
            docType: "config",
            clientId: clientUser.id,
            isActive: true
          }
        });
      }

      if (validatedKnowledge.processes) {
        await tx.knowledgeDocument.create({
          data: {
            title: "Processus et Procédures",
            content: validatedKnowledge.processes,
            docType: "process",
            clientId: clientUser.id,
            isActive: true
          }
        });
      }

      if (validatedKnowledge.clientData) {
        await tx.knowledgeDocument.create({
          data: {
            title: "Données Client",
            content: validatedKnowledge.clientData,
            docType: "text",
            clientId: clientUser.id,
            isActive: true
          }
        });
      }

      if (validatedKnowledge.additionalDocs && validatedKnowledge.additionalDocs.length > 0) {
        for (const doc of validatedKnowledge.additionalDocs) {
          await tx.knowledgeDocument.create({
            data: {
              title: doc.title,
              content: doc.content,
              docType: "text",
              clientId: clientUser.id,
                isActive: true
            }
          });
        }
      }

      return {
        workspace: newWorkspace,
        client: clientUser,
        teamMembers,
        planId: finalPlanId
      };
    });

    // 5. Send invitation emails
    const appUrl = process.env.APP_URL || "http://localhost:5173";

    // Send client welcome email with temp password
    const clientTempPassword = Math.random().toString(36).slice(-10);
    const clientUpdateResult = await prisma.user.update({
      where: { id: result.client.id },
      data: {
        passwordHash: bcrypt.hashSync(clientTempPassword, 12) // Set temp password
      }
    });

    try {
      await sendEmail({
        userId: result.client.id,
        workspaceId: result.workspace.id,
        to: result.client.email,
        subject: `Bienvenue sur Sellsia - Votre workspace est prêt`,
        html: `
          <h2>Bienvenue ${validatedClient.firstName}!</h2>
          <p>Votre workspace <strong>${validatedWorkspace.workspaceName}</strong> est maintenant actif sur Sellsia.</p>
          <p><strong>Accès initial:</strong></p>
          <ul>
            <li>Email: ${result.client.email}</li>
            <li>Mot de passe temporaire: ${clientTempPassword}</li>
          </ul>
          <p><a href="${appUrl}/login">Se connecter</a></p>
          <p>Vous devrez changer votre mot de passe lors de votre première connexion.</p>
        `
      });
    } catch (emailErr) {
      console.warn("[onboarding] Failed to send client email:", emailErr.message);
    }

    // Send team member invitations
    for (const member of result.teamMembers) {
      try {
        await sendEmail({
          userId: result.client.id,
          workspaceId: result.workspace.id,
          to: member.user.email,
          subject: `Invitation à rejoindre ${validatedWorkspace.workspaceName} sur Sellsia`,
          html: `
            <h2>Vous êtes invité!</h2>
            <p>Vous êtes invité à rejoindre le workspace <strong>${validatedWorkspace.workspaceName}</strong>.</p>
            <p><strong>Vos identifiants:</strong></p>
            <ul>
              <li>Email: ${member.user.email}</li>
              <li>Mot de passe temporaire: ${member.tempPassword}</li>
            </ul>
            <p><a href="${appUrl}/login">Se connecter</a></p>
          `
        });
      } catch (emailErr) {
        console.warn(`[onboarding] Failed to send team member email to ${member.user.email}:`, emailErr.message);
      }
    }

    return res.json({
      success: true,
      workspace: result.workspace,
      client: {
        id: result.client.id,
        email: result.client.email,
        companyName: result.client.companyName
      },
      teamCount: result.teamMembers.length,
      knowledgeDocuments: validatedKnowledge.additionalDocs?.length || 0,
      planId: result.planId
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error("[onboarding] Create error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/onboarding/client/create-multipart
 * Same as /client/create but accepts FormData (parses JSON from req.body.data field)
 * Accepts file uploads: processes, clientData, and handles orgChart JSON
 */
router.post(
  "/client/create-multipart",
  requireAuth,
  requireRole("admin"),
  upload.fields([
    { name: "processes", maxCount: 10 },
    { name: "clientData", maxCount: 10 }
  ]),
  async (req, res) => {
  try {
    // Parse the JSON data field from FormData
    let parsedData;
    try {
      parsedData = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body;
    } catch {
      parsedData = req.body;
    }

    const { clientInfo, workspace: workspaceData, team, planId, newPlan } = parsedData;

    const validatedClient = clientInfoSchema.parse(clientInfo);
    const validatedWorkspace = workspaceSchema.parse(workspaceData);
    const validatedTeam = teamSchema.parse(team || { members: [] });

    const result = await prisma.$transaction(async (tx) => {
      let finalPlanId = planId ? Number(planId) : null;

      if (newPlan) {
        const createdPlan = await tx.plan.create({
          data: {
            name: newPlan.name,
            monthlyTokenLimit: newPlan.monthlyTokenLimit || 100000,
            collaboratorLimit: newPlan.maxUsers || 10,
            priceEurMonth: newPlan.priceEurMonth || 0,
            featuresJson: JSON.stringify(
              Object.entries(newPlan.permissions || {})
                .filter(([_, v]) => v)
                .map(([k]) => k)
            ),
            permissionsJson: JSON.stringify(newPlan.permissions || {}),
            maxSubClients: newPlan.maxSubClients || 0,
            maxUsers: newPlan.maxUsers || 10,
            maxAgents: newPlan.maxAgents || 5,
            isActive: true,
          }
        });
        finalPlanId = createdPlan.id;
      }

      const workspaceName = validatedWorkspace.workspaceName;
      const slug = await generateUniqueSlug(workspaceName, tx);

      const newWorkspace = await tx.workspace.create({
        data: {
          name: workspaceName,
          slug,
          status: "active",
          plan: "professional",
          ...(finalPlanId ? { planId: finalPlanId } : {})
        }
      });

      const passwordHash = bcrypt.hashSync(Math.random().toString(36).slice(-10), 12);
      const clientUser = await tx.user.create({
        data: {
          email: validatedClient.email.toLowerCase(),
          passwordHash,
          role: "client",
          companyName: validatedClient.companyName,
          workspaceId: newWorkspace.id
        }
      });

      const teamMembers = [];
      for (const member of validatedTeam.members) {
        const memberPassword = Math.random().toString(36).slice(-10);
        const memberHash = bcrypt.hashSync(memberPassword, 12);
        const teamMember = await tx.user.create({
          data: {
            email: member.email.toLowerCase(),
            passwordHash: memberHash,
            role: "sub_client",
            companyName: validatedClient.companyName,
            workspaceId: newWorkspace.id
          }
        });
        teamMembers.push({ user: teamMember, tempPassword: memberPassword });
      }

      return { workspace: newWorkspace, client: clientUser, teamMembers, planId: finalPlanId };
    });

    // ── Create Knowledge Documents from uploads ──
    const { orgChart } = parsedData;
    const processFiles = req.files?.processes || [];
    const clientDataFiles = req.files?.clientData || [];

    // Create org chart knowledge document (from OCR extraction)
    if (orgChart) {
      try {
        let orgChartData;
        if (typeof orgChart === "string") {
          orgChartData = JSON.parse(orgChart);
        } else {
          orgChartData = orgChart;
        }

        await prisma.knowledgeDocument.create({
          data: {
            title: "Organigramme",
            content: JSON.stringify(orgChartData),
            docType: "config",
            clientId: result.client.id,
            scope: "workspace",
            metadataJson: JSON.stringify({ category: "orgchart", source: "ocr" }),
            isActive: true
          }
        });
      } catch (err) {
        console.warn("[onboarding] Failed to save org chart KB:", err.message);
      }
    }

    // Create process/procedure knowledge documents
    for (const file of processFiles) {
      try {
        const content = file.buffer.toString("utf-8");
        await prisma.knowledgeDocument.create({
          data: {
            title: file.originalname,
            content,
            docType: "process",
            clientId: result.client.id,
            scope: "workspace",
            metadataJson: JSON.stringify({ category: "processes", filename: file.originalname, size: file.size }),
            isActive: true
          }
        });
      } catch (err) {
        console.warn(`[onboarding] Failed to save process file ${file.originalname}:`, err.message);
      }
    }

    // Create client data knowledge documents
    for (const file of clientDataFiles) {
      try {
        const content = file.buffer.toString("utf-8");
        await prisma.knowledgeDocument.create({
          data: {
            title: file.originalname,
            content,
            docType: "text",
            clientId: result.client.id,
            scope: "workspace",
            metadataJson: JSON.stringify({ category: "client_data", filename: file.originalname, size: file.size }),
            isActive: true
          }
        });
      } catch (err) {
        console.warn(`[onboarding] Failed to save client data file ${file.originalname}:`, err.message);
      }
    }

    // Send invitation emails
    const appUrl = process.env.APP_URL || "http://localhost:5173";
    const clientTempPassword = Math.random().toString(36).slice(-10);
    await prisma.user.update({
      where: { id: result.client.id },
      data: { passwordHash: bcrypt.hashSync(clientTempPassword, 12) }
    });

    try {
      await sendEmail({
        userId: result.client.id,
        workspaceId: result.workspace.id,
        to: result.client.email,
        subject: `Bienvenue sur Sellsia - Votre workspace est prêt`,
        html: `<h2>Bienvenue ${validatedClient.firstName}!</h2><p>Workspace: ${validatedWorkspace.workspaceName}</p><p>Email: ${result.client.email}</p><p>Mot de passe: ${clientTempPassword}</p><p><a href="${appUrl}/login">Se connecter</a></p>`
      });
    } catch (emailErr) {
      console.warn("[onboarding] Failed to send client email:", emailErr.message);
    }

    for (const member of result.teamMembers) {
      try {
        await sendEmail({
          userId: result.client.id,
          workspaceId: result.workspace.id,
          to: member.user.email,
          subject: `Invitation à rejoindre ${validatedWorkspace.workspaceName}`,
          html: `<h2>Invitation!</h2><p>Email: ${member.user.email}</p><p>Mot de passe: ${member.tempPassword}</p><p><a href="${appUrl}/login">Se connecter</a></p>`
        });
      } catch (emailErr) {
        console.warn(`[onboarding] Failed to send email to ${member.user.email}:`, emailErr.message);
      }
    }

    return res.json({
      success: true,
      workspace: result.workspace,
      client: { id: result.client.id, email: result.client.email },
      teamCount: result.teamMembers.length,
      planId: result.planId
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error("[onboarding] Create multipart error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Generate unique workspace slug
 */
async function generateUniqueSlug(baseName, prismaClient = prisma) {
  const baseSlug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);

  let slug = baseSlug;
  for (let i = 1; i <= 10; i++) {
    const existing = await prismaClient.workspace.findUnique({
      where: { slug },
      select: { id: true }
    });
    if (!existing) return slug;
    slug = `${baseSlug.substring(0, 45)}-${i}`;
  }

  throw new Error("Unable to generate unique workspace slug");
}

export default router;
