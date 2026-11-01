import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

// AES-256-GCM for secrets at rest (OAuth tokens, API keys) and HMAC-signed
// tokens for links that must not be forgeable (unsubscribe, OAuth state).

function key(): Buffer {
  const k = Buffer.from(serverEnv.encryptionKey(), "base64");
  if (k.length !== 32) throw new Error("TIDEMARK_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptJson<T>(payload: string): T {
  const [version, iv, tag, body] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unrecognized ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

function hmac(data: string): string {
  return createHmac("sha256", serverEnv.cronSecret()).update(data).digest("base64url");
}

/** Signed, expiring token carrying a small JSON payload. */
export function signToken(payload: Record<string, unknown>, ttlSeconds = 60 * 60 * 24 * 365): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${body}.${hmac(body)}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(hmac(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof data.exp === "number" && data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

/** Constant-time bearer check for worker/cron endpoints. */
export function isAuthorizedCron(header: string | null): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(serverEnv.cronSecret());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
