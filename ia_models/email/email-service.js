/**
 * email-service.js
 *
 * Service d'envoi d'email via la config SMTP de l'utilisateur (Phase 2).
 * Si aucune config user n'est trouvée, fallback sur la config globale (env vars).
 */

import nodemailer from "nodemailer";
import crypto from "crypto";
import { prisma } from "../../src/prisma.js";
import { decryptSecret } from "../../src/security/secrets.js";

const ENCRYPTION_KEY = process.env.SMTP_ENCRYPTION_KEY || "sellsia-default-32-byte-key------";
const IV_LENGTH = 16;

/**
 * Chiffre un mot de passe SMTP avec AES-256-CBC.
 */
export function encryptSmtpPassword(plaintext) {
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32), "utf8");
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

/**
 * Déchiffre un mot de passe SMTP stocké en base.
 */
export function decryptSmtpPassword(encrypted) {
  const [ivHex, encHex] = encrypted.split(":");
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32), "utf8");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/**
 * Retourne un transporteur nodemailer pour un utilisateur donné.
 * Essaie d'abord la config EmailConfig de l'utilisateur,
 * puis la config globale sauvegardée lors du setup,
 * puis fallback sur les variables d'env globales.
 */
export async function getTransporterForUser(userId) {
  // 1. Config utilisateur
  const config = await prisma.emailConfig.findUnique({
    where: { userId },
  });

  if (config && config.isActive) {
    const pass = decryptSmtpPassword(config.smtpPassEncrypted);
    return {
      transporter: nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: { user: config.smtpUser, pass },
      }),
      from: config.fromName
        ? `"${config.fromName}" <${config.fromEmail}>`
        : config.fromEmail,
      configId: config.id,
    };
  }

  // 2. Config globale (sauvegardée lors du setup wizard)
  try {
    const systemSmtpSetting = await prisma.systemSetting.findUnique({
      where: { key: "system_smtp_config" }
    });

    if (systemSmtpSetting && systemSmtpSetting.value) {
      const globalConfig = JSON.parse(systemSmtpSetting.value);
      const decryptedPass = decryptSecret(globalConfig.passEncrypted);

      return {
        transporter: nodemailer.createTransport({
          host: globalConfig.host,
          port: globalConfig.port,
          secure: globalConfig.secure,
          auth: { user: globalConfig.user, pass: decryptedPass },
        }),
        from: globalConfig.fromName
          ? `"${globalConfig.fromName}" <${globalConfig.fromEmail}>`
          : globalConfig.fromEmail,
        configId: null,
      };
    }
  } catch (err) {
    console.warn("[email-service] Failed to load global SMTP config:", err.message);
  }

  // 3. Fallback env vars
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || "noreply@sellsia.io";

  if (!host || !user || !pass) {
    throw new Error("Aucune configuration SMTP disponible");
  }

  return {
    transporter: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    }),
    from,
    configId: null,
  };
}

/**
 * Envoie un email et enregistre le log.
 *
 * @param {{ userId, workspaceId?, to, cc?, bcc?, subject, text?, html, reminderId? }} opts
 */
export async function sendEmail({ userId, workspaceId, to, cc, bcc, subject, text, html, reminderId }) {
  const smtp = await getTransporterForUser(userId);

  await smtp.transporter.sendMail({
    from: smtp.from,
    to,
    cc,
    bcc,
    subject,
    text: text || subject,
    html,
  });

  // Resolve workspaceId if not provided
  let resolvedWorkspaceId = workspaceId;
  if (!resolvedWorkspaceId && userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { workspaceId: true }
    });
    resolvedWorkspaceId = user?.workspaceId;
  }

  // Log en base
  await prisma.emailLog.create({
    data: {
      userId,
      workspaceId: resolvedWorkspaceId,
      configId: smtp.configId,
      toAddress: Array.isArray(to) ? to.join(", ") : to,
      ccAddress: cc ? (Array.isArray(cc) ? cc.join(", ") : cc) : null,
      bccAddress: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc) : null,
      subject,
      bodySnippet: (text || html || "").slice(0, 200),
      status: "sent",
      reminderId: reminderId ?? null,
    },
  });
}

/**
 * Retourne la configuration SMTP globale sauvegardée lors du setup.
 * Utilisée pour les emails système (2FA, reset password, etc.)
 */
export async function getGlobalSmtpConfig() {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: "system_smtp_config" }
    });

    if (!setting || !setting.value) {
      return null;
    }

    const config = JSON.parse(setting.value);
    return {
      host: config.host,
      port: config.port,
      user: config.user,
      pass: decryptSecret(config.passEncrypted),
      secure: config.secure,
      fromEmail: config.fromEmail,
      fromName: config.fromName
    };
  } catch (err) {
    console.warn("[email-service] Failed to load global SMTP config:", err.message);
    return null;
  }
}

/**
 * Vérifie une configuration SMTP.
 */
export async function verifySmtpConfig({ host, port, user, pass, secure }) {
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 10000, // 10s
  });

  try {
    await transporter.verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
