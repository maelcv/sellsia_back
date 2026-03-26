/**
 * reminder-email.js
 *
 * Envoi de rappels par email via nodemailer.
 * Phase 1 : utilise la config SMTP globale (variables d'env).
 * Phase 2 : utilisera la config SMTP par utilisateur (EmailConfig model).
 */

import nodemailer from "nodemailer";
import escapeHtml from "escape-html";

/**
 * Crée un transporteur SMTP depuis les variables d'environnement.
 * Retourne null si la config n'est pas définie.
 */
function getGlobalTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || "noreply@sellsia.io";

  if (!host || !user || !pass) {
    return null;
  }

  return {
    transporter: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    }),
    from,
  };
}

/**
 * Envoie un rappel par email.
 *
 * @param {Object} reminder - L'objet Reminder complet depuis la DB
 */
export async function sendReminderViaEmail(reminder) {
  if (!reminder.targetEmail) {
    throw new Error("Email cible manquant pour le canal email");
  }

  const smtp = getGlobalTransporter();
  if (!smtp) {
    throw new Error("Configuration SMTP non définie (SMTP_HOST, SMTP_USER, SMTP_PASS)");
  }

  // Escape HTML to prevent injection attacks
  const escapedDescription = escapeHtml(reminder.taskDescription);
  const scheduledTime = reminder.scheduledAt.toLocaleString("fr-FR", {
    timeZone: reminder.timezone || "Europe/Paris"
  });

  const mailOptions = {
    from: smtp.from,
    to: reminder.targetEmail,
    subject: `🔔 Rappel Sellsia : ${reminder.taskDescription.slice(0, 80)}`,
    text: `Bonjour,\n\nVoici votre rappel :\n\n${reminder.taskDescription}\n\nPlanifié pour : ${scheduledTime}\n\n— Sellsia`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #6366f1;">🔔 Rappel Sellsia</h2>
        <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="font-size: 16px; color: #1e293b; margin: 0;">${escapedDescription}</p>
        </div>
        <p style="color: #64748b; font-size: 14px;">
          Planifié pour : ${escapeHtml(scheduledTime)}
        </p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #94a3b8; font-size: 12px;">Envoyé par Sellsia</p>
      </div>
    `,
  };

  await smtp.transporter.sendMail(mailOptions);
}
