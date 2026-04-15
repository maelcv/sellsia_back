/**
 * Mailer for market reports. Reuses the workspace-aware email service
 * at backend/ia_models/email/email-service.js so SMTP config is resolved
 * per user / workspace.
 */
import { getTransporterForUser } from "../../email/email-service.js";

export async function sendReportEmail({
  userId,
  to,
  subject,
  htmlBody,
  pdfBuffer = null,
  pdfFilename = "rapport.pdf",
}) {
  const smtp = await getTransporterForUser(userId);
  await smtp.transporter.sendMail({
    from: smtp.from,
    to,
    subject,
    html: htmlBody,
    attachments: pdfBuffer && pdfBuffer.length > 0
      ? [{ filename: pdfFilename, content: pdfBuffer }]
      : [],
  });
  return { success: true };
}
