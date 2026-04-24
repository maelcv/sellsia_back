import dotenv from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Load .env from backend root
dotenv.config({ path: resolve(__dirname, "../.env") });

const isProduction = process.env.NODE_ENV === "production";
const isStaging = process.env.NODE_ENV === "staging";

// ── Validation des secrets au démarrage ──
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error(
    `FATAL: JWT_SECRET must be set and at least 32 characters. ` +
    `Current: ${process.env.JWT_SECRET ? process.env.JWT_SECRET.length + " chars" : "not set"}. ` +
    `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  );
}

const jwtSecret = process.env.JWT_SECRET;

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


export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:4000,http://localhost:5173,https://www.sellsy.com,https://sellsy.com,https://boatswain-front.vercel.app,https://boatswain-front-jt37do6jn-mcv-dev.vercel.app",
  databaseUrl: process.env.DATABASE_URL || "postgresql://localhost:5432/boatswain",
  encryptionKey: process.env.APP_ENCRYPTION_KEY || "",
  removeDemoData: (process.env.REMOVE_DEMO_DATA || "true").toLowerCase() === "true",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION || "v22.0",
  // Timeouts pour les routes IA longue durée (en ms)
  chatStreamTimeoutMs: Number(process.env.CHAT_STREAM_TIMEOUT_MS || 720000),
  chatAskTimeoutMs: Number(process.env.CHAT_ASK_TIMEOUT_MS || 300000),
  // Market reports (cgiraud integration)
  mistralApiKey: process.env.MISTRAL_API_KEY || "",
  newsDataApiKey: process.env.NEWSDATA_IO_API_KEY || "",
  marketReportsStorageDir:
    process.env.MARKET_REPORTS_STORAGE_DIR ||
    resolve(__dirname, "../storage/market-reports"),
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "",
  publicApiUrl: process.env.PUBLIC_API_URL || "",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  googleOauthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || ""
};
