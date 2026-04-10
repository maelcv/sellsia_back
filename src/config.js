import dotenv from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Load .env from backend root
dotenv.config({ path: resolve(__dirname, "../.env") });

const DEV_JWT_SECRET = "dev-secret-change-me-local-only";
const isProduction = process.env.NODE_ENV === "production";
const isStaging = process.env.NODE_ENV === "staging";

// ── Validation des secrets au démarrage ──
// JWT Secret must ALWAYS be explicitly configured, even in development
if (!process.env.JWT_SECRET) {
  if (isProduction || isStaging) {
    throw new Error(
      "FATAL: JWT_SECRET environment variable is required in " + process.env.NODE_ENV + " environment. " +
      "Generate a secure random value (min 32 chars) and set it."
    );
  }
  console.warn(
    "[CONFIG] WARNING: JWT_SECRET not set. Using insecure dev default. " +
    "This MUST be set to a secure random value before any non-local deployment."
  );
}

const jwtSecret = process.env.JWT_SECRET || DEV_JWT_SECRET;

// Validate JWT secret entropy (minimum 32 characters for HS256)
if (jwtSecret.length < 32 && (isProduction || isStaging)) {
  throw new Error(
    "FATAL: JWT_SECRET must be at least 32 characters for HS256 security. Current length: " + jwtSecret.length
  );
}

if (jwtSecret.length < 32 && !isProduction && !isStaging) {
  console.warn(
    `[CONFIG] WARNING: JWT_SECRET is only ${jwtSecret.length} chars. ` +
    "Minimum recommended is 32 chars for adequate security."
  );
}

if (!process.env.APP_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY.length < 32) {
  if (isProduction || isStaging) {
    throw new Error(
      "FATAL: APP_ENCRYPTION_KEY must be set and at least 32 chars in production/staging."
    );
  }
  if (process.env.APP_ENCRYPTION_KEY) {
    console.warn(
      `[CONFIG] WARNING: APP_ENCRYPTION_KEY is only ${process.env.APP_ENCRYPTION_KEY.length} chars. ` +
      "Minimum recommended is 32 chars."
    );
  }
}

if (!process.env.WHATSAPP_VERIFY_TOKEN) {
  if (isProduction || isStaging) {
    throw new Error(
      "FATAL: WHATSAPP_VERIFY_TOKEN must be set in production/staging. " +
      "Generate a secure random value and set it."
    );
  }
  console.warn(
    "[CONFIG] WARNING: WHATSAPP_VERIFY_TOKEN not set. Using insecure default. " +
    "This is a security risk and must be changed before production."
  );
}

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:4000,http://localhost:5173,https://www.sellsy.com,https://sellsy.com,https://sellsia-front.vercel.app,https://sellsia-front-jt37do6jn-mcv-dev.vercel.app",
  databaseUrl: process.env.DATABASE_URL || "postgresql://localhost:5432/sellsia",
  encryptionKey: process.env.APP_ENCRYPTION_KEY || "",
  removeDemoData: (process.env.REMOVE_DEMO_DATA || "true").toLowerCase() === "true",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION || "v22.0",
  whatsappVerifyToken:
    process.env.WHATSAPP_VERIFY_TOKEN ||
    (isProduction || isStaging ? "" : "dev-whatsapp-verify-token-local-only"),
  // Timeouts pour les routes IA longue durée (en ms)
  chatStreamTimeoutMs: Number(process.env.CHAT_STREAM_TIMEOUT_MS || 720000),
  chatAskTimeoutMs: Number(process.env.CHAT_ASK_TIMEOUT_MS || 300000),
  // Market reports (cgiraud integration)
  mistralApiKey: process.env.MISTRAL_API_KEY || "",
  newsDataApiKey: process.env.NEWSDATA_IO_API_KEY || "",
  marketReportsStorageDir:
    process.env.MARKET_REPORTS_STORAGE_DIR ||
    resolve(__dirname, "../storage/market-reports"),
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || ""
};
