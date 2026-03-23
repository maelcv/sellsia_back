/**
 * WhatsApp Routes — Webhook entrant Meta + API gestion.
 *
 * GET  /api/whatsapp/webhook           — Vérification webhook Meta
 * POST /api/whatsapp/webhook           — Réception messages entrants
 * POST /api/whatsapp/send              — Envoi manuel de message
 * GET  /api/whatsapp/accounts          — Liste comptes WhatsApp Business
 * POST /api/whatsapp/accounts          — Ajouter un compte Business
 * DELETE /api/whatsapp/accounts/:id    — Supprimer un compte Business
 * GET  /api/whatsapp/conversations     — Liste conversations WhatsApp
 */

import express from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { config } from "../config.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { encryptSecret, decryptSecret } from "../security/secrets.js";
import { validateWhatsappSignature } from "../middleware/whatsapp-signature.js";
import {
  sendTextMessage,
  markAsRead,
  parseWebhookPayload
} from "../providers/whatsapp-connector.js";
import { getProviderForUser } from "../../../../ia_models/providers/index.js";
import { orchestrate } from "../../../../ia_models/orchestrator/dispatcher.js";
import {
  addMessage,
  getConversationHistory
} from "../../../../ia_models/orchestrator/memory.js";
import { getAvailableTools } from "../../../../ia_models/mcp/tools.js";
import { enrichContext, loadKnowledgeContext, getSellsyClient } from "../../../../ia_models/orchestrator/context.js";

const router = express.Router();

// ── Schemas ──

const accountSchema = z.object({
  businessPhoneNumberId: z.string().min(1).max(64),
  accessToken: z.string().min(10).max(512),
  phoneNumber: z.string().min(6).max(20),
  displayName: z.string().max(128).optional(),
  appSecret: z.string().min(10).max(256)
});

const sendSchema = z.object({
  conversationId: z.string().max(128).optional(),
  to: z.string().min(6).max(20),
  message: z.string().min(1).max(4096),
  accountId: z.string().max(128)
});

// ══════════════════════════════════════════════════════
// GET /api/whatsapp/webhook — Vérification Meta
// ══════════════════════════════════════════════════════

router.get("/webhook", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token) {
    // Verify token matches an active WhatsApp Business account configured by an admin
    const account = await prisma.whatsappAccount.findFirst({
      where: { webhookVerifyToken: token, status: "active" },
      select: { id: true }
    });

    if (account) {
      console.log(`[WhatsApp] Webhook verified for account ${account.id}`);
      return res.status(200).send(challenge);
    }

    console.warn("[WhatsApp] Webhook verification failed — no matching account token");
    return res.sendStatus(403);
  }

  return res.sendStatus(400);
});

// ══════════════════════════════════════════════════════
// POST /api/whatsapp/webhook — Messages entrants Meta
// ══════════════════════════════════════════════════════

router.post("/webhook", async (req, res) => {
  // 1. Validate X-Hub-Signature-256 against the account's app secret.
  //    We extract the phone_number_id from the payload to look up the right account.
  const signature = req.headers["x-hub-signature-256"];
  if (signature && req.rawBody) {
    const phoneNumberId = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (phoneNumberId) {
      const account = await prisma.whatsappAccount.findFirst({
        where: { businessPhoneNumberId: phoneNumberId, status: "active" },
        select: { appSecretEncrypted: true }
      });

      if (account?.appSecretEncrypted) {
        const appSecret = decryptSecret(account.appSecretEncrypted);
        const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          console.warn("[WhatsApp] Invalid webhook signature for phone", phoneNumberId);
          return res.sendStatus(401);
        }
      }
    }
  }

  // 2. Respond 200 immediately — Meta expects < 20s response
  res.sendStatus(200);

  try {
    const events = parseWebhookPayload(req.body);

    for (const event of events) {
      if (event.type === "status") {
        handleStatusUpdate(event);
        continue;
      }

      if (event.type === "message") {
        processIncomingMessage(event).catch((err) => {
          console.error("[WhatsApp] Error processing message:", err);
        });
      }
    }
  } catch (err) {
    console.error("[WhatsApp] Webhook processing error:", err);
  }
});

// ── Process an incoming WhatsApp message ──

async function processIncomingMessage(event) {
  const { phoneNumberId, from, messageId, text, messageType, contact } = event;

  // 1. Find the WhatsApp account matching this phone number ID
  const account = await prisma.whatsappAccount.findFirst({
    where: { businessPhoneNumberId: phoneNumberId, status: "active" }
  });

  if (!account) {
    console.warn(`[WhatsApp] No active account for phone_number_id ${phoneNumberId}`);
    return;
  }

  const userId = account.userId;
  const accessToken = decryptSecret(account.accessTokenEncrypted);

  // 2. Mark as read
  markAsRead({ accessToken, businessPhoneNumberId: phoneNumberId, messageId }).catch(() => {});

  // 3. Upsert channel contact
  const profileName = contact?.profile?.name || null;
  await prisma.channelContact.upsert({
    where: {
      userId_whatsappPhone: { userId, whatsappPhone: from }
    },
    update: {
      whatsappProfileName: profileName || undefined,
      lastInteraction: new Date().toISOString()
    },
    create: {
      id: crypto.randomUUID(),
      userId,
      whatsappPhone: from,
      whatsappProfileName: profileName,
      lastInteraction: new Date().toISOString()
    }
  });

  // 4. Find or create conversation for this WhatsApp phone
  let conversation = await prisma.conversation.findFirst({
    where: { userId, channel: "whatsapp", channelPhoneFrom: from },
    orderBy: { updatedAt: "desc" },
    select: { id: true }
  });

  let conversationId;
  if (conversation) {
    conversationId = conversation.id;
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() }
    });
  } else {
    conversationId = crypto.randomUUID();
    const title = profileName ? `WhatsApp — ${profileName}` : `WhatsApp — ${from}`;
    await prisma.conversation.create({
      data: {
        id: conversationId,
        userId,
        agentId: null,
        title,
        contextType: "whatsapp",
        channel: "whatsapp",
        channelPhoneFrom: from
      }
    });
  }

  // 5. Only process text messages for now (media support can be added later)
  const userMessage = text || `[${messageType}]`;

  // Save user message
  await addMessage(conversationId, { role: "user", content: userMessage });

  // Save WhatsApp-specific metadata
  await prisma.whatsappMessage.create({
    data: {
      conversationId,
      whatsappMessageId: messageId,
      direction: "inbound",
      whatsappPhone: from,
      messageType: messageType || "text"
    }
  });

  // 6. Get provider and orchestrate AI response
  const provider = await getProviderForUser(userId);
  if (!provider) {
    await sendWhatsAppReply(accessToken, phoneNumberId, from,
      "Aucun fournisseur IA configure. Connectez un service IA dans votre dashboard Sellsia.");
    return;
  }

  // Get allowed agents
  const agentRows = await prisma.$queryRaw`
    SELECT a.id FROM user_agent_access uaa
    JOIN agents a ON a.id = uaa.agent_id
    WHERE uaa.user_id = ${userId} AND uaa.status = 'granted' AND a.is_active = true`;

  if (agentRows.length === 0) {
    await sendWhatsAppReply(accessToken, phoneNumberId, from,
      "Aucun agent IA active. Activez un agent depuis le dashboard Sellsia.");
    return;
  }

  const allowedIds = new Set(agentRows.map((r) => r.id));

  try {
    // Enrich context (no page context for WhatsApp)
    const sellsyData = await enrichContext(userId, {});
    const conversationHistory = (await getConversationHistory(conversationId, 20)).slice(0, -1);
    const knowledgeContext = await loadKnowledgeContext(userMessage, "commercial", userId);

    // Build tool context
    const sellsyClient = await getSellsyClient(userId);
    const toolContext = {
      sellsyClient,
      tavilyApiKey: config.tavilyApiKey || null,
      uploadedFiles: [],
      thinkingMode: "low",
      priorityDomains: ["wikipedia.org", "pappers.fr", "societe.com"],
      forceWebSearch: false
    };
    const tools = getAvailableTools(toolContext, { includeFileTools: false, thinkingMode: "low" });

    // Orchestrate (synchronous — no streaming for WhatsApp)
    const result = await orchestrate({
      provider,
      userMessage,
      pageContext: {},
      sellsyData,
      conversationHistory,
      userRole: "client",
      clientId: userId,
      conversationId,
      allowedAgents: allowedIds,
      requestedAgentId: null,
      tools,
      toolContext,
      knowledgeContext,
      thinkingMode: "low"
    });

    // Save assistant message
    await addMessage(conversationId, {
      role: "assistant",
      content: result.answer,
      agentId: result.agentId,
      tokensInput: result.tokensInput || 0,
      tokensOutput: result.tokensOutput || 0,
      provider: result.provider,
      model: result.model,
      sourcesUsed: result.sourcesUsed || { web: [], sellsy: [], files: [] }
    });

    // Update token usage
    const total = (result.tokensInput || 0) + (result.tokensOutput || 0);
    if (total > 0) {
      try {
        await prisma.$executeRaw`
          UPDATE client_plans
          SET token_used = token_used + ${total},
              token_sent = token_sent + ${result.tokensInput || 0},
              token_received = token_received + ${result.tokensInput || 0},
              token_processed = token_processed + ${total},
              token_returned = token_returned + ${result.tokensOutput || 0},
              updated_at = NOW()
          WHERE user_id = ${userId}`;
      } catch { /* ignore */ }
    }

    // 7. Send reply via WhatsApp
    const waResponse = await sendWhatsAppReply(accessToken, phoneNumberId, from, result.answer);

    // Save outbound WhatsApp message metadata
    if (waResponse?.messages?.[0]?.id) {
      await prisma.whatsappMessage.create({
        data: {
          conversationId,
          whatsappMessageId: waResponse.messages[0].id,
          direction: "outbound",
          whatsappPhone: from,
          messageType: "text",
          status: "sent"
        }
      });
    }

    await logAudit(userId, "WHATSAPP_MESSAGE", {
      conversationId,
      agentId: result.agentId,
      from,
      direction: "inbound+outbound"
    });
  } catch (err) {
    console.error("[WhatsApp] AI orchestration error:", err);
    await sendWhatsAppReply(accessToken, phoneNumberId, from,
      "Desole, une erreur s'est produite lors du traitement de votre message. Veuillez reessayer.");
  }
}

async function sendWhatsAppReply(accessToken, businessPhoneNumberId, to, text) {
  // WhatsApp messages are limited to ~4096 chars. Truncate if needed.
  const truncated = text.length > 4000 ? text.slice(0, 3997) + "..." : text;

  return sendTextMessage({ accessToken, businessPhoneNumberId, to, text: truncated });
}

// ── Handle delivery status updates ──

async function handleStatusUpdate(event) {
  const { messageId, status, errorCode, errorTitle } = event;

  if (!messageId) return;

  const errorDetails = errorCode ? JSON.stringify({ code: errorCode, title: errorTitle }) : null;

  await prisma.whatsappMessage.updateMany({
    where: { whatsappMessageId: messageId },
    data: {
      status,
      ...(errorDetails ? { errorDetails } : {})
    }
  });
}

// ══════════════════════════════════════════════════════
// POST /api/whatsapp/send — Envoi manuel (auth required)
// ══════════════════════════════════════════════════════

router.post("/send", requireAuth, async (req, res) => {
  const parse = sendSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { to, message, accountId, conversationId } = parse.data;
  const userId = req.user.sub;

  // Verify ownership of WhatsApp account
  const account = await prisma.whatsappAccount.findFirst({
    where: { id: accountId, userId, status: "active" }
  });

  if (!account) {
    return res.status(404).json({ error: "WhatsApp account not found" });
  }

  try {
    const accessToken = decryptSecret(account.accessTokenEncrypted);
    const waResponse = await sendTextMessage({
      accessToken,
      businessPhoneNumberId: account.businessPhoneNumberId,
      to,
      text: message
    });

    // Save to conversation if provided
    if (conversationId) {
      await addMessage(conversationId, { role: "assistant", content: message });

      if (waResponse?.messages?.[0]?.id) {
        await prisma.whatsappMessage.create({
          data: {
            conversationId,
            whatsappMessageId: waResponse.messages[0].id,
            direction: "outbound",
            whatsappPhone: to,
            messageType: "text",
            status: "sent"
          }
        });
      }
    }

    await logAudit(userId, "WHATSAPP_SEND", { to, accountId });
    return res.json({ success: true, messageId: waResponse?.messages?.[0]?.id });
  } catch (err) {
    console.error("[WhatsApp] Send error:", err);
    return res.status(502).json({ error: "Failed to send WhatsApp message" });
  }
});

// ══════════════════════════════════════════════════════
// GET /api/whatsapp/accounts — Liste comptes (admin)
// ══════════════════════════════════════════════════════

router.get("/accounts", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const isAdmin = req.user.role === "admin";

  const rows = await prisma.whatsappAccount.findMany({
    where: isAdmin ? {} : { userId },
    orderBy: { createdAt: "desc" }
  });

  const accounts = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    businessPhoneNumberId: row.businessPhoneNumberId,
    phoneNumber: row.phoneNumber,
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));

  return res.json({ accounts });
});

// ══════════════════════════════════════════════════════
// POST /api/whatsapp/accounts — Ajouter un compte (admin)
// ══════════════════════════════════════════════════════

router.post("/accounts", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = accountSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid account payload" });
  }

  const { businessPhoneNumberId, accessToken, phoneNumber, displayName, appSecret } = parse.data;
  const userId = req.user.sub;

  // Check duplicate
  const existing = await prisma.whatsappAccount.findFirst({
    where: { businessPhoneNumberId },
    select: { id: true }
  });

  if (existing) {
    return res.status(409).json({ error: "This Business Phone Number ID is already registered" });
  }

  const id = crypto.randomUUID();
  const webhookVerifyToken = crypto.randomBytes(32).toString("hex");

  await prisma.whatsappAccount.create({
    data: {
      id,
      userId,
      businessPhoneNumberId,
      phoneNumber,
      displayName: displayName || null,
      accessTokenEncrypted: encryptSecret(accessToken),
      appSecretEncrypted: encryptSecret(appSecret),
      webhookVerifyToken,
      status: "active"
    }
  });

  await logAudit(userId, "WHATSAPP_ACCOUNT_CREATED", { accountId: id, phoneNumber });

  return res.status(201).json({
    account: {
      id,
      businessPhoneNumberId,
      phoneNumber,
      displayName: displayName || null,
      webhookVerifyToken,
      status: "active"
    }
  });
});

// ══════════════════════════════════════════════════════
// PUT /api/whatsapp/accounts/:id — Mettre à jour les clés (admin)
// ══════════════════════════════════════════════════════

const accountUpdateSchema = z.object({
  accessToken: z.string().min(10).max(512).optional(),
  appSecret: z.string().min(10).max(256).optional(),
  displayName: z.string().max(128).optional(),
  status: z.enum(["active", "inactive"]).optional()
});

router.put("/accounts/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const parse = accountUpdateSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const accountId = req.params.id;
  const account = await prisma.whatsappAccount.findUnique({
    where: { id: accountId },
    select: { id: true }
  });
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  const { accessToken, appSecret, displayName, status } = parse.data;
  const data = {};

  if (accessToken) {
    data.accessTokenEncrypted = encryptSecret(accessToken);
  }
  if (appSecret) {
    data.appSecretEncrypted = encryptSecret(appSecret);
  }
  if (displayName !== undefined) {
    data.displayName = displayName || null;
  }
  if (status) {
    data.status = status;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  data.updatedAt = new Date();

  await prisma.whatsappAccount.update({
    where: { id: accountId },
    data
  });

  await logAudit(req.user.sub, "WHATSAPP_ACCOUNT_UPDATED", { accountId, fields: Object.keys(parse.data) });
  return res.json({ success: true });
});

// ══════════════════════════════════════════════════════
// DELETE /api/whatsapp/accounts/:id — Supprimer un compte
// ══════════════════════════════════════════════════════

router.delete("/accounts/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const userId = req.user.sub;
  const accountId = req.params.id;

  const account = await prisma.whatsappAccount.findUnique({
    where: { id: accountId },
    select: { id: true }
  });
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  await prisma.whatsappAccount.update({
    where: { id: accountId },
    data: { status: "revoked", updatedAt: new Date() }
  });

  await logAudit(userId, "WHATSAPP_ACCOUNT_REVOKED", { accountId });
  return res.json({ success: true });
});

// ══════════════════════════════════════════════════════
// GET /api/whatsapp/conversations — Conversations WhatsApp
// ══════════════════════════════════════════════════════

router.get("/conversations", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  const conversations = await prisma.$queryRaw`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) as message_count,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
      cc.whatsapp_profile_name
    FROM conversations c
    LEFT JOIN channel_contacts cc ON cc.user_id = c.user_id AND cc.whatsapp_phone = c.channel_phone_from
    WHERE c.user_id = ${userId} AND c.channel = 'whatsapp'
    ORDER BY c.updated_at DESC
    LIMIT ${limit}`;

  return res.json({ conversations });
});

export default router;
