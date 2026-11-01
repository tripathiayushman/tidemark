import type { SupabaseClient } from "@supabase/supabase-js";
import { apiFetch, getAccessToken, oauthRedirectUri, type RefreshFn } from "@/lib/integrations/connections";
import { serverEnv } from "@/lib/env";

// Gmail REST + Google OAuth helpers and RFC 2822 message building.
// Endpoints confirmed against developers.google.com (identity/protocols/oauth2/web-server,
// workspace/gmail/api/reference). Never log tokens or message bodies from here.

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_BASE_SCOPES = ["openid", "email", GMAIL_READ_SCOPE] as const;

// ── OAuth ─────────────────────────────────────────────────────────────────

export interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string; // space-delimited
  token_type?: string;
}

export function googleOAuthConfigured(): boolean {
  return Boolean(serverEnv.googleClientId() && serverEnv.googleClientSecret());
}

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = serverEnv.googleClientId();
  const clientSecret = serverEnv.googleClientSecret();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)");
  return { clientId, clientSecret };
}

/** Consent URL. `sending` adds gmail.send incrementally on top of what was granted. */
export function googleAuthUrl(p: { state: string; sending: boolean; loginHint?: string | null }): string {
  const { clientId } = clientCredentials();
  const scopes: string[] = [...GMAIL_BASE_SCOPES];
  if (p.sending) scopes.push(GMAIL_SEND_SCOPE);
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", oauthRedirectUri("gmail"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", p.state);
  if (p.loginHint) url.searchParams.set("login_hint", p.loginHint);
  return url.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<GoogleTokenResponse> {
  return apiFetch<GoogleTokenResponse>(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

export async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = clientCredentials();
  return tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: oauthRedirectUri("gmail"),
    grant_type: "authorization_code",
  });
}

export const refreshGoogleToken: RefreshFn = async (refreshToken) => {
  const { clientId, clientSecret } = clientCredentials();
  const t = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in };
};

/** Valid access token for a Gmail connection (refreshed + persisted when expiring). */
export function gmailAccessToken(db: SupabaseClient, connectionId: string): Promise<string> {
  return getAccessToken(db, connectionId, refreshGoogleToken);
}

// ── REST ──────────────────────────────────────────────────────────────────

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // epoch ms
  payload?: GmailMessagePart;
}

export async function getProfile(token: string): Promise<{ emailAddress: string; historyId?: string }> {
  return apiFetch(`${GMAIL_API}/profile`, { token });
}

/** All {id, threadId} matching a Gmail search query (paged, capped). */
export async function listMessageIds(token: string, q: string, maxResults = 2000): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await apiFetch<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(url.toString(), { token });
    out.push(...(res.messages ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken && out.length < maxResults);
  return out.slice(0, maxResults);
}

export async function getMessage(
  token: string,
  id: string,
  opts: { format?: "full" | "metadata"; metadataHeaders?: string[] } = {},
): Promise<GmailMessage> {
  const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", opts.format ?? "full");
  for (const h of opts.metadataHeaders ?? []) url.searchParams.append("metadataHeaders", h);
  return apiFetch<GmailMessage>(url.toString(), { token });
}

/** users.threads.get with headers only (no bodies). */
export async function getThreadMetadata(token: string, threadId: string, metadataHeaders: string[]): Promise<{ id: string; messages?: GmailMessage[] }> {
  const url = new URL(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}`);
  url.searchParams.set("format", "metadata");
  for (const h of metadataHeaders) url.searchParams.append("metadataHeaders", h);
  return apiFetch(url.toString(), { token });
}

/** Error from users.messages.send, keeping the HTTP status for classification. */
export class GmailSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(message);
    this.name = "GmailSendError";
  }
}

/**
 * users.messages.send with a base64url RFC 2822 message. Deliberately does
 * NOT retry 5xx/timeouts (the message may already have gone out); only 429,
 * which Gmail returns before accepting the message, is retried.
 */
export async function sendRawMessage(token: string, raw: string, threadId?: string | null): Promise<{ id: string; threadId: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GMAIL_API}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return (await res.json()) as { id: string; threadId: string };
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
      continue;
    }
    const text = (await res.text()).slice(0, 500);
    let reason: string | null = null;
    let message = text;
    try {
      const j = JSON.parse(text) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
      reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? null;
      message = j.error?.message ?? text;
    } catch {
      // non-JSON error body
    }
    throw new GmailSendError(`Gmail send → ${res.status}: ${message.slice(0, 200)}`, res.status, reason);
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────

export function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

export interface Address {
  name: string | null;
  email: string;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Parses "Name <a@b.com>, c@d.com, \"Last, First\" <e@f.com>" into addresses (emails lowercased). */
export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  const pieces: string[] = [];
  let buf = "";
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && quoted && i + 1 < value.length) {
      buf += ch + value[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      pieces.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  pieces.push(buf);

  const out: Address[] = [];
  for (const raw of pieces) {
    const piece = raw.trim();
    if (!piece) continue;
    const m = /^(.*)<([^<>]+)>\s*$/.exec(piece);
    const email = (m ? m[2] : piece).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    let name = m ? m[1].trim() : "";
    name = name.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
    out.push({ name: name && name.toLowerCase() !== email ? name : null, email });
  }
  return out;
}

export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

export function encodeBase64Url(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}

/** First inline text/plain part of a message, decoded. HTML-only mail yields null. */
export function extractPlainText(part: GmailMessagePart | undefined, maxChars = 20_000): string | null {
  if (!part) return null;
  const isAttachment = Boolean(part.filename) || /attachment/i.test(headerValue(part.headers, "Content-Disposition") ?? "");
  if (part.mimeType === "text/plain" && !isAttachment && part.body?.data) {
    return decodeBase64Url(part.body.data).slice(0, maxChars);
  }
  for (const child of part.parts ?? []) {
    const text = extractPlainText(child, maxChars);
    if (text) return text;
  }
  return null;
}

const BOUNCE_SENDER = /^(mailer-daemon|postmaster)@/i;

/** Delivery-failure notice? (Delay notices are not bounces: the message may still deliver.) */
export function isBounceMessage(fromEmail: string | null, subject: string | null): boolean {
  const s = subject ?? "";
  if (/\bdelay(ed)?\b/i.test(s)) return false;
  return (fromEmail != null && BOUNCE_SENDER.test(fromEmail)) || /delivery status notification/i.test(s);
}

export function isSystemSender(email: string): boolean {
  return BOUNCE_SENDER.test(email) || /^(no-?reply|do-?not-?reply)@/i.test(email);
}

/** Auto-responders (out-of-office etc.) per RFC 3834 Auto-Submitted and common vendor headers. */
export function isAutoReply(headers: GmailHeader[] | undefined, subject: string | null): boolean {
  const autoSubmitted = headerValue(headers, "Auto-Submitted");
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== "no") return true;
  if (headerValue(headers, "X-Autoreply") || headerValue(headers, "X-Autorespond")) return true;
  const precedence = (headerValue(headers, "Precedence") ?? "").toLowerCase();
  if (precedence === "auto_reply") return true;
  return /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)\b/i.test((subject ?? "").trim());
}

// ── MIME building ─────────────────────────────────────────────────────────

/** Strip CR/LF so values can't inject headers. */
function clean(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encoded-words for non-ASCII header text, split to stay under 75 chars each. */
export function encodeHeaderText(value: string): string {
  const v = clean(value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let chunk = "";
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

export function formatAddress(a: { name?: string | null; email: string }): string {
  const email = clean(a.email);
  const name = a.name ? clean(a.name) : "";
  if (!name) return `<${email}>`;
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${email}>`;
  return `${encodeHeaderText(name)} <${email}>`;
}

export interface MimeInput {
  from: { name?: string | null; email: string };
  to: { name?: string | null; email: string };
  subject: string;
  body: string; // plain text
  inReplyTo?: string | null;
  references?: string | null;
  /** HTTPS one-click endpoint (RFC 8058). */
  listUnsubscribeUrl: string;
}

/**
 * RFC 2822 plain-text message with RFC 8058 one-click unsubscribe headers.
 * UNVERIFIED: that Gmail keeps the supplied From display name and passes the custom
 * List-Unsubscribe / List-Unsubscribe-Post headers through unchanged on users.messages.send
 * (the docs only say the raw message must be RFC 2822, base64url-encoded).
 */
export function buildMimeMessage(m: MimeInput): string {
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${formatAddress(m.to)}`,
    `Subject: ${encodeHeaderText(m.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (m.inReplyTo) headers.push(`In-Reply-To: ${clean(m.inReplyTo)}`);
  if (m.references) headers.push(`References: ${clean(m.references)}`);
  headers.push(`List-Unsubscribe: <${clean(m.listUnsubscribeUrl)}>`);
  headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");

  const body = m.body.replace(/\r\n|\r|\n/g, "\r\n");
  const encoded = (Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${encoded}\r\n`;
}
