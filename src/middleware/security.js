import rateLimit from "express-rate-limit";

export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500, // 100 req/min — allows 2s polling
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." }
});

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." }
});

// Webhook public endpoint — stricter limit (60 req/15 min per IP)
export const webhookRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many webhook requests." }
});

// Chat AI endpoints — moderate limit per authenticated user (20 req/min)
export const chatRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub || req.ip, // Use userId if available
  skip: (req) => req.user?.role === "admin", // Admins bypass
  message: { error: "Trop de demandes. Veuillez attendre avant de relancer une conversation." }
});
