import crypto from "crypto";

export function validateWhatsappSignature(appSecret) {
  return (req, res, next) => {
    if (!appSecret) {
      console.error("[WhatsApp] No app secret configured");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
      return res.status(401).json({ error: "Missing X-Hub-Signature-256 header" });
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      console.error("[WhatsApp] rawBody not available");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const expectedSignature = "sha256=" + crypto
      .createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      console.warn("[WhatsApp] Invalid webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    next();
  };
}
