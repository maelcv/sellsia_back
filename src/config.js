import dotenv from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Load .env from backend root
dotenv.config({ path: resolve(__dirname, "../.env") });

const DEV_JWT_SECRET = "dev-secret-change-me";
const isProduction = process.env.NODE_ENV === "production";

// ── Validation des secrets au démarrage ──
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_JWT_SECRET) {
  if (isProduction) {
    throw new Error("FATAL: JWT_SECRET must be set to a strong random value in production.");
  }
  console.warn("[CONFIG] WARNING: Using insecure default JWT_SECRET. Set JWT_SECRET env var before going to production.");
}

if (!process.env.APP_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY.length < 32) {
  if (isProduction) {
    throw new Error("FATAL: APP_ENCRYPTION_KEY must be set and at least 32 chars in production.");
  }
  if (process.env.APP_ENCRYPTION_KEY) {
    console.warn("[CONFIG] WARNING: APP_ENCRYPTION_KEY is shorter than 32 chars. Increase it before going to production.");
  }
}

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:4000,http://localhost:5173,https://www.sellsy.com,https://sellsy.com,https://sellsia-front.vercel.app,https://sellsia-front-jt37do6jn-mcv-dev.vercel.app",
  databaseUrl: process.env.DATABASE_URL || "postgresql://localhost:5432/sellsia",
  encryptionKey: process.env.APP_ENCRYPTION_KEY || "",
  removeDemoData: (process.env.REMOVE_DEMO_DATA || "true").toLowerCase() === "true",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION || "v22.0",
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "sellsia-whatsapp-verify-2024"
};
