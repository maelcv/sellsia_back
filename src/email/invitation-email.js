/**
 * invitation-email.js
 *
 * Sends workspace invitation emails to invited sub-clients.
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
  const from = process.env.SMTP_FROM || "noreply@boatswain.io";

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
 * Envoie une invitation workspace par email.
 *
 * @param {Object} options
 * @param {string} options.to - Email destinataire
 * @param {string} options.workspaceName - Nom du workspace
 * @param {string} options.inviterName - Nom du client qui invite
 * @param {string} options.invitationToken - Token unique pour accepter l'invitation
 * @param {Date} options.expiresAt - Quand l'invitation expire
 */
export async function sendInvitationEmail({ to, workspaceName, inviterName, invitationToken, expiresAt }) {
  const smtp = getGlobalTransporter();
  if (!smtp) {
    throw new Error("Configuration SMTP non définie (SMTP_HOST, SMTP_USER, SMTP_PASS)");
  }

  const frontendUrl = process.env.FRONTEND_URL || "https://app.boatswain.io";
  const acceptLink = `${frontendUrl}/accept-invitation?token=${encodeURIComponent(invitationToken)}`;
  const expiresInDays = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  const escapedWorkspaceName = escapeHtml(workspaceName);
  const escapedInviterName = escapeHtml(inviterName);

  const mailOptions = {
    from: smtp.from,
    to,
    subject: `🎉 ${escapedInviterName} vous invite à rejoindre ${escapedWorkspaceName}`,
    text: `
Bonjour,

${escapedInviterName} vous invite à rejoindre l'espace de travail "${escapedWorkspaceName}" sur Boatswain.

Cliquez sur ce lien pour accepter l'invitation :
${acceptLink}

Cette invitation expirera dans ${expiresInDays} jours.

— Boatswain
    `,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
        <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 32px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Invitation Workspace</h1>
        </div>

        <div style="padding: 32px; background: #f8f9fa; border: 1px solid #e2e8f0; border-radius: 0 0 8px 8px;">
          <p style="margin-top: 0; font-size: 16px;">
            <strong>${escapedInviterName}</strong> vous invite à rejoindre l'espace de travail :
          </p>

          <div style="background: white; border: 2px solid #6366f1; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
            <h2 style="margin: 0; font-size: 24px; color: #6366f1;">${escapedWorkspaceName}</h2>
          </div>

          <div style="text-align: center; margin: 32px 0;">
            <a href="${escapeHtml(acceptLink)}" style="
              display: inline-block;
              background: #6366f1;
              color: white;
              padding: 12px 32px;
              border-radius: 6px;
              text-decoration: none;
              font-weight: 600;
              font-size: 16px;
            ">Accepter l'invitation</a>
          </div>

          <p style="margin: 24px 0 0 0; font-size: 14px; color: #666;">
            Ou copiez ce lien :
            <br />
            <code style="background: #f0f0f0; padding: 8px; border-radius: 4px; word-break: break-all; display: block; margin-top: 8px;">
              ${escapeHtml(acceptLink)}
            </code>
          </p>

          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />

          <p style="font-size: 12px; color: #999; margin: 0;">
            Cette invitation expirera dans <strong>${expiresInDays} jours</strong>.
            <br />
            Si vous n'avez pas demandé cette invitation, vous pouvez ignorer cet email.
          </p>
        </div>

        <div style="text-align: center; padding: 16px; color: #999; font-size: 12px;">
          <p>© ${new Date().getFullYear()} Boatswain. Tous droits réservés.</p>
        </div>
      </div>
    `,
  };

  await smtp.transporter.sendMail(mailOptions);
}
