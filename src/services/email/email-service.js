/**
 * email-service.js
 *
 * Service d'envoi d'email via la config SMTP de l'utilisateur (Phase 2).
 * Si aucune config user n'est trouvée, fallback sur la config globale (env vars).
 */

import nodemailer from "nodemailer";
import crypto from "crypto";
import { prisma } from "../../prisma.js";
import { decryptSecret } from "../../security/secrets.js";

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

  // 3. Fallback variable d'environnement (SMTP_HOST, SMTP_PORT, etc.)
  const host = process.env.SMTP_HOST || "localhost";
  const port = parseInt(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || `"Sellsia" <noreply@sellsia.ai>`;

  return {
    transporter: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
    }),
    from,
    configId: null,
  };
}

/**
 * Génère un template HTML élégant pour les emails Sellsia.
 */
export function renderEmailTemplate({ title, content, buttonLabel, buttonUrl }) {
  const brandColor = "#1DD3A7";
  const accentColor = "#9B1DFF";
  const bgColor = "#0A0A0B";
  const surfaceColor = "#141416";
  const textColor = "#FFFFFF";
  const mutedColor = "#A1A1AA";

  return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&display=swap" rel="stylesheet">
      <style>
        body { 
          margin: 0; 
          padding: 0; 
          font-family: 'Space Grotesk', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
          background-color: ${bgColor}; 
          color: ${textColor}; 
        }
        .wrapper { 
          width: 100%; 
          padding: 60px 20px; 
          box-sizing: border-box; 
          background: linear-gradient(135deg, ${bgColor} 0%, #111111 100%);
        }
        .container { 
          max-width: 600px; 
          margin: 0 auto; 
          background-color: ${surfaceColor}; 
          border-radius: 32px; 
          border: 1px solid rgba(255,255,255,0.08); 
          overflow: hidden; 
          box-shadow: 0 40px 100px rgba(0,0,0,0.6); 
        }
        .header { 
          padding: 50px 40px 30px; 
          text-align: center; 
          background: linear-gradient(to bottom, rgba(29, 211, 167, 0.05), transparent);
        }
        .logo { 
          font-size: 32px; 
          font-weight: 700; 
          color: ${brandColor}; 
          letter-spacing: -1.5px; 
          margin-bottom: 10px;
          text-transform: uppercase;
        }
        .badge {
          display: inline-block;
          padding: 4px 12px;
          background: rgba(29, 211, 167, 0.1);
          color: ${brandColor};
          border-radius: 100px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .content { 
          padding: 0 50px 50px; 
          line-height: 1.7; 
        }
        h1 { 
          font-size: 28px; 
          font-weight: 700; 
          margin-bottom: 20px; 
          color: ${textColor}; 
          letter-spacing: -0.5px;
        }
        p { 
          font-size: 16px; 
          color: ${mutedColor}; 
          margin-bottom: 28px; 
        }
        .button-container {
          text-align: center;
          margin: 35px 0 10px;
        }
        .button { 
          display: inline-block; 
          padding: 16px 40px; 
          background: linear-gradient(135deg, ${brandColor} 0%, #16b891 100%); 
          color: #000000; 
          text-decoration: none; 
          border-radius: 16px; 
          font-weight: 700; 
          font-size: 16px; 
          box-shadow: 0 10px 20px rgba(29, 211, 167, 0.2);
          transition: transform 0.2s ease; 
        }
        .footer { 
          padding: 40px 50px; 
          background-color: rgba(255,255,255,0.03); 
          text-align: center; 
          border-top: 1px solid rgba(255,255,255,0.08); 
        }
        .footer-text { 
          font-size: 13px; 
          color: rgba(255,255,255,0.4); 
          margin: 5px 0;
        }
        .verification-code { 
          font-size: 36px; 
          font-weight: 700; 
          color: ${textColor}; 
          letter-spacing: 12px; 
          margin: 35px 0; 
          text-align: center; 
          padding: 30px; 
          background: linear-gradient(135deg, rgba(29, 211, 167, 0.08) 0%, rgba(155, 29, 255, 0.08) 100%); 
          border-radius: 24px; 
          border: 1px solid rgba(255,255,255,0.1); 
          box-shadow: inset 0 2px 10px rgba(0,0,0,0.2);
        }
        .accent-line {
          height: 4px;
          background: linear-gradient(90deg, ${brandColor}, ${accentColor});
          margin-bottom: 40px;
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="accent-line"></div>
          <div class="header">
            <div class="logo">Sellsia</div>
            <div class="badge">Intelligence Artificielle</div>
          </div>
          <div class="content">
            <h1>${title}</h1>
            ${content}
            ${buttonLabel && buttonUrl ? `
              <div class="button-container">
                <a href="${buttonUrl}" class="button">${buttonLabel}</a>
              </div>
            ` : ""}
          </div>
          <div class="footer">
            <p class="footer-text">© ${new Date().getFullYear()} Sellsia AI Platform. Excellence en relation client.</p>
            <p class="footer-text">Cet email a été généré par l'infrastructure sécurisée de Sellsia.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
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
    html: html || (text ? `<p>${text}</p>` : ""), // Fallback to wrap text in basic html
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
