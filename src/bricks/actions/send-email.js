import { z } from "../types.js";
import { resolveSmtpTransportForAutomation } from "../../services/automations/integration-resolvers.js";

function normalizeAddressList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "string") {
    return value
      .split(/[\n,;]/g)
      .map((item) => item.trim())
      .filter(Boolean)
      .join(", ");
  }

  return "";
}

function toTextFallback(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const sendEmailAction = {
  id: "action:send_email",
  category: "action",
  name: "Envoyer un email",
  description: "Envoie un email via la configuration SMTP du workspace.",
  icon: "Mail",
  color: "#1dd3a7",

  inputSchema: z.object({
    to:      z.string().optional().describe("Destinataire(s), séparés par des virgules"),
    toList:  z.any().optional().describe("Liste de destinataires (array)"),
    subject: z.string().describe("Objet de l'email"),
    body:    z.string().describe("Corps de l'email (HTML ou texte)"),
    cc:      z.string().optional().describe("Copie (CC)"),
    ccList:  z.any().optional().describe("Liste CC (array)"),
    smtpSource: z.string().optional().describe("Source SMTP: auto | workspace:<id> | user:<id>"),
  }),

  outputSchema: z.object({
    sent:    z.boolean(),
    to:      z.string(),
    subject: z.string(),
    source:  z.string().optional(),
  }),

  async execute(inputs, context) {
    const { to, toList, subject, body, cc, ccList, smtpSource } = inputs;

    const toAddress = normalizeAddressList(toList) || normalizeAddressList(to);
    const ccAddress = normalizeAddressList(ccList) || normalizeAddressList(cc);

    if (!toAddress) throw new Error("to est requis");
    if (!subject) throw new Error("subject est requis");
    if (!body)    throw new Error("body est requis");

    const smtp = await resolveSmtpTransportForAutomation({
      workspaceId: context.workspaceId,
      userId: context.userId,
      userRole: context.userRole,
      sourceRef: smtpSource,
    });

    if (smtp) {
      await smtp.transporter.sendMail({
        from: smtp.from,
        to: toAddress,
        cc: ccAddress || undefined,
        subject,
        text: toTextFallback(body) || subject,
        html: body,
      });

      return { sent: true, to: toAddress, subject, source: smtp.label };
    }

    const { sendEmail } = await import("../../services/email/email-service.js");
    await sendEmail({
      userId:      context.userId,
      workspaceId: context.workspaceId,
      to: toAddress,
      cc: ccAddress || undefined,
      subject,
      html: body,
    });

    return { sent: true, to: toAddress, subject, source: "auto" };
  },
};
