/**
 * reminder-email.js
 *
 * Envoi de rappels par email en s'appuyant sur le service SMTP unifié :
 * - config SMTP utilisateur/workspace
 * - fallback SMTP plateforme
 */

import { sendEmail, renderEmailTemplate } from "../email/email-service.js";

/**
 * Envoie un rappel par email.
 *
 * @param {Object} reminder - L'objet Reminder complet depuis la DB
 */
export async function sendReminderViaEmail(reminder) {
  if (!reminder.targetEmail) {
    throw new Error("Email cible manquant pour le canal email");
  }

  const scheduledTime = reminder.scheduledAt.toLocaleString("fr-FR", {
    timeZone: reminder.timezone || "Europe/Paris"
  });

  const html = renderEmailTemplate({
    title: "Rappel Sellsia",
    content: `
      <p>Bonjour,</p>
      <p>Voici votre rappel :</p>
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;margin:16px 0;">
        <p style="margin:0;color:#fff;">${reminder.taskDescription}</p>
      </div>
      <p><strong>Planifié pour :</strong> ${scheduledTime}</p>
    `,
  });

  await sendEmail({
    userId: reminder.userId,
    to: reminder.targetEmail,
    subject: `Rappel Sellsia: ${reminder.taskDescription.slice(0, 80)}`,
    text: `Bonjour,\n\nVoici votre rappel :\n\n${reminder.taskDescription}\n\nPlanifié pour : ${scheduledTime}\n\n- Sellsia`,
    html,
    reminderId: reminder.id,
  });
}
