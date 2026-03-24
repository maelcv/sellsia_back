import { config } from "../config.js";
import twilio from "twilio";

const BASE_URL = `https://graph.facebook.com/${config.whatsappApiVersion}`;

export async function sendTextMessage({ accessToken, businessPhoneNumberId, to, text }) {
  const url = `${BASE_URL}/${businessPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text }
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API error: ${err?.error?.message || `HTTP ${res.status}`}`);
  }
  return res.json();
}

export async function sendMediaMessage({ accessToken, businessPhoneNumberId, to, mediaType, mediaUrl, caption, filename }) {
  const url = `${BASE_URL}/${businessPhoneNumberId}/messages`;
  const mediaPayload = { link: mediaUrl };
  if (caption && (mediaType === "image" || mediaType === "document")) mediaPayload.caption = caption;
  if (filename && mediaType === "document") mediaPayload.filename = filename;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: mediaType,
      [mediaType]: mediaPayload
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp media send error: ${err?.error?.message || `HTTP ${res.status}`}`);
  }
  return res.json();
}

export async function sendTemplateMessage({ accessToken, businessPhoneNumberId, to, templateName, languageCode = "en_US", components = [] }) {
  const url = `${BASE_URL}/${businessPhoneNumberId}/messages`;
  const template = { name: templateName, language: { code: languageCode } };
  if (components.length > 0) template.components = components;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp template send error: ${err?.error?.message || `HTTP ${res.status}`}`);
  }
  return res.json();
}

export async function markAsRead({ accessToken, businessPhoneNumberId, messageId }) {
  const url = `${BASE_URL}/${businessPhoneNumberId}/messages`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId })
  });
}

export async function downloadMedia({ accessToken, mediaId }) {
  const metaRes = await fetch(`${BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!metaRes.ok) throw new Error(`Failed to get media URL for ${mediaId}`);
  const { url, mime_type } = await metaRes.json();

  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!fileRes.ok) throw new Error(`Failed to download media from ${url}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: mime_type };
}

export function parseWebhookPayload(body) {
  const events = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id;

      for (const msg of value?.messages || []) {
        events.push({
          type: "message",
          phoneNumberId,
          from: msg.from,
          messageId: msg.id,
          timestamp: msg.timestamp,
          messageType: msg.type,
          text: msg.text?.body || null,
          mediaId: msg.image?.id || msg.document?.id || msg.audio?.id || msg.video?.id || null,
          mediaMimeType: msg.image?.mime_type || msg.document?.mime_type || msg.audio?.mime_type || msg.video?.mime_type || null,
          caption: msg.image?.caption || msg.document?.caption || null,
          filename: msg.document?.filename || null,
          contact: (value.contacts || []).find(c => c.wa_id === msg.from) || null
        });
      }

      for (const status of value?.statuses || []) {
        events.push({
          type: "status",
          phoneNumberId,
          recipientId: status.recipient_id,
          messageId: status.id,
          status: status.status,
          timestamp: status.timestamp,
          errorCode: status.errors?.[0]?.code || null,
          errorTitle: status.errors?.[0]?.title || null
        });
      }
    }
  }
  return events;
}

// ─── Twilio Connector ─────────────────────────────────────────────────────────

export async function sendTwilioTextMessage({ accountSid, authToken, from, to, text }) {
  const client = twilio(accountSid, authToken);
  const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const formattedFrom = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;

  const message = await client.messages.create({
    from: formattedFrom,
    to: formattedTo,
    body: text
  });

  return { messages: [{ id: message.sid }] };
}

export async function sendTwilioTemplateMessage({ accountSid, authToken, from, to, templateName, components = [] }) {
  // mapped templates for Twilio require a contentSid. 
  // without it, we fallback to text message
  console.warn("[Twilio] Using text fallback for template message request because ContentSid mapping is not provided.");
  return sendTwilioTextMessage({ accountSid, authToken, from, to, text: `[Template: ${templateName}]` });
}

export function parseTwilioWebhookPayload(body) {
  const events = [];
  
  // body is already parsed by express.urlencoded
  if (body.MessageStatus) {
    events.push({
      type: "status",
      phoneNumberId: body.To.replace("whatsapp:", ""),
      recipientId: body.To,
      messageId: body.MessageSid,
      status: body.MessageStatus, // queued, failed, sent, delivered, read
      timestamp: Math.floor(Date.now() / 1000).toString(),
      errorCode: body.ErrorCode || null,
      errorTitle: body.ErrorMessage || null
    });
  } else if (body.Body !== undefined) {
    events.push({
      type: "message",
      phoneNumberId: body.To.replace("whatsapp:", ""),
      from: body.From.replace("whatsapp:", ""),
      messageId: body.MessageSid,
      timestamp: Math.floor(Date.now() / 1000).toString(),
      messageType: body.MediaUrl0 ? "image" : "text", // naive media check
      text: body.Body || null,
      mediaId: body.MediaUrl0 || null, // Not a true ID but URL
      mediaMimeType: body.MediaContentType0 || null,
      contact: { 
        wa_id: body.From.replace("whatsapp:", ""),
        profile: { name: body.ProfileName || null }
      }
    });
  }

  return events;
}
