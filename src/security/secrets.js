import crypto from "crypto";
import { config } from "../config.js";

let _cachedKey = null;

function getKey() {
  if (_cachedKey) return _cachedKey;

  if (!config.encryptionKey || config.encryptionKey.length < 32) {
    throw new Error("APP_ENCRYPTION_KEY must be set and at least 32 chars");
  }

  _cachedKey = crypto.pbkdf2Sync(
    config.encryptionKey,
    "boatswain-aes256gcm-v1",
    100_000,
    32,
    "sha256"
  );
  return _cachedKey;
}

export function encryptSecret(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${authTag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(payload) {
  if (!payload) return "";
  const [ivB64, tagB64, encryptedB64] = String(payload).split(".");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

export function maskSecret(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-1)}`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}
