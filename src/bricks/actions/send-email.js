import { z } from "../types.js";

export const sendEmailAction = {
  id: "action:send_email",
  category: "action",
  name: "Envoyer un email",
  description: "Envoie un email via la configuration SMTP du workspace.",
  icon: "Mail",
  color: "#1dd3a7",

  inputSchema: z.object({
    to:      z.string().describe("Destinataire(s), séparés par des virgules"),
    subject: z.string().describe("Objet de l'email"),
    body:    z.string().describe("Corps de l'email (HTML ou texte)"),
    cc:      z.string().optional().describe("Copie (CC)"),
  }),

  outputSchema: z.object({
    sent:    z.boolean(),
    to:      z.string(),
    subject: z.string(),
  }),

  async execute(inputs, context) {
    const { to, subject, body, cc } = inputs;
    if (!to)      throw new Error("to est requis");
    if (!subject) throw new Error("subject est requis");
    if (!body)    throw new Error("body est requis");

    const { sendEmail } = await import("../../services/email/email-service.js");
    await sendEmail({
      userId:      context.userId,
      workspaceId: context.workspaceId,
      to,
      cc,
      subject,
      html: body,
    });

    return { sent: true, to, subject };
  },
};
