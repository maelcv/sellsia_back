import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma, hasAnyUsers } from "../prisma.js";
import { verifySmtpConfig } from "../services/email/email-service.js";
import { encryptSecret } from "../security/secrets.js";

const router = Router();

// Helper to check if setup is already done
async function isSetupComplete() {
  const setting = await prisma.systemSetting.findUnique({ where: { key: "setup_completed" } });
  return setting?.value === "true";
}

// ──────────────────────────────────────────────────────────────
// STEP 1: Check Database Connection
// ──────────────────────────────────────────────────────────────

router.get("/check-db", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "connected" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// STEP 2: Test Email Connection (SMTP config from env)
// ──────────────────────────────────────────────────────────────

const mailTestSchema = z.object({
  email: z.string().email("Email invalide"),
  password: z.string().min(1, "Mot de passe requis")
});

router.post("/test-mail", async (req, res) => {
  try {
    const { email, password } = mailTestSchema.parse(req.body);

    // Read SMTP config from environment variables
    const smtpConfig = {
      host: process.env.SMTP_HOST || "",
      port: parseInt(process.env.SMTP_PORT || "587"),
      user: email,
      pass: password,
      secure: process.env.SMTP_SECURE === "true",
      fromEmail: process.env.SMTP_FROM_EMAIL || email,
      fromName: process.env.SMTP_FROM_NAME || "Boatswain"
    };

    // Validate that required SMTP env vars are set
    if (!smtpConfig.host) {
      return res.status(400).json({
        success: false,
        error: "Serveur SMTP non configuré dans les variables d'environnement"
      });
    }

    // Test the connection with provided credentials
    const result = await verifySmtpConfig(smtpConfig);

    if (result.success) {
      // Save SMTP credentials securely for platform-wide email sending
      const encryptedPassword = encryptSecret(password);

      await prisma.systemSetting.upsert({
        where: { key: "system_smtp_config" },
        update: { value: JSON.stringify({
          host: smtpConfig.host,
          port: smtpConfig.port,
          user: email,
          passEncrypted: encryptedPassword,
          secure: smtpConfig.secure,
          fromEmail: smtpConfig.fromEmail,
          fromName: smtpConfig.fromName
        }) },
        create: { key: "system_smtp_config", value: JSON.stringify({
          host: smtpConfig.host,
          port: smtpConfig.port,
          user: email,
          passEncrypted: encryptedPassword,
          secure: smtpConfig.secure,
          fromEmail: smtpConfig.fromEmail,
          fromName: smtpConfig.fromName
        }) }
      });

      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: err.errors[0]?.message || "Validation error"
      });
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// STEP 3: Create Admin User
// ──────────────────────────────────────────────────────────────

const createAdminSchema = z.object({
  email: z.string().email("Email invalide"),
  password: z.string().min(8, "Min. 8 caractères")
});

router.post("/create-admin", async (req, res) => {
  try {
    const { email, password } = createAdminSchema.parse(req.body);

    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({
      where: { role: "ADMIN" }
    });

    if (existingAdmin) {
      return res.status(400).json({
        error: "Un admin existe déjà. L'onboarding est terminé."
      });
    }

    // Create admin user
    const passwordHash = bcrypt.hashSync(password, 12);
    const admin = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        role: "ADMIN",
        companyName: "Admin"
      }
    });

    // Mark setup as complete
    await prisma.systemSetting.upsert({
      where: { key: "setup_completed" },
      update: { value: "true" },
      create: { key: "setup_completed", value: "true" }
    });

    res.json({ success: true, userId: admin.id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: err.errors[0]?.message || "Validation error"
      });
    }
    console.error("[Setup] Create admin error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// Status Check (for landing page)
// ──────────────────────────────────────────────────────────────

router.get("/status", async (req, res) => {
  try {
    const complete = await isSetupComplete();
    const hasUsers = await hasAnyUsers();
    res.json({
      setupComplete: complete,
      hasUsers,
      dbConnected: true
    });
  } catch (err) {
    res.status(500).json({
      setupComplete: false,
      dbConnected: false,
      error: err.message
    });
  }
});

export default router;
