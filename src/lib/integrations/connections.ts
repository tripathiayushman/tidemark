import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptJson, encryptJson, signToken, verifyToken } from "@/lib/crypto";
import { publicEnv } from "@/lib/env";
import type { Provider } from "@/lib/types";

// Shared plumbing for every integration:
//   * secrets are AES-GCM encrypted into integration_secrets (service role only)
//   * OAuth `state` is an HMAC-signed token binding workspace + user + provider
//   * getAccessToken() refreshes OAuth tokens transparently via the provider's
//     refresh function and persists the new token

export interface StoredSecret {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // epoch seconds
  api_key?: string;
  [k: string]: unknown;
}

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: Provider;
  status: "active" | "error" | "disconnected";
  account_label: string | null;
  external_account_id: string;
  scopes: string[];
  settings: Record<string, unknown>;
  connected_by: string | null;
  last_synced_at: string | null;
  sync_cursor: Record<string, unknown>;
}

export function oauthRedirectUri(provider: Provider): string {
  return `${publicEnv.appUrl()}/api/oauth/${provider}/callback`;
}

export function makeOAuthState(p: { workspaceId: string; userId: string; provider: Provider; extra?: Record<string, unknown> }): string {
  return signToken({ ws: p.workspaceId, uid: p.userId, pr: p.provider, ...(p.extra ?? {}) }, 15 * 60);
}

export function readOAuthState(state: string | null, provider: Provider): { workspaceId: string; userId: string; extra: Record<string, unknown> } | null {
  if (!state) return null;
  const data = verifyToken<{ ws: string; uid: string; pr: string }>(state);
  if (!data || data.pr !== provider) return null;
  const { ws, uid, ...rest } = data as Record<string, unknown> & { ws: string; uid: string };
  const extra = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "pr" && k !== "exp"));
  return { workspaceId: ws, userId: uid, extra };
}

export async function saveConnection(
  db: SupabaseClient,
  c: {
    workspaceId: string;
    provider: Provider;
    externalAccountId: string;
    accountLabel: string | null;
    scopes?: string[];
    settings?: Record<string, unknown>;
    connectedBy: string;
    secret: StoredSecret;
  },
): Promise<ConnectionRow> {
  const { data, error } = await db
    .from("integration_connections")
    .upsert(
      {
        workspace_id: c.workspaceId,
        provider: c.provider,
        external_account_id: c.externalAccountId,
        account_label: c.accountLabel,
        scopes: c.scopes ?? [],
        settings: c.settings ?? {},
        connected_by: c.connectedBy,
        status: "active",
        error: null,
      },
      { onConflict: "workspace_id,provider,external_account_id" },
    )
    .select("*")
    .single();
  if (error) throw new Error(`save connection: ${error.message}`);
  await putSecret(db, data.id, c.secret);
  return data as ConnectionRow;
}

export async function putSecret(db: SupabaseClient, connectionId: string, secret: StoredSecret) {
  const { error } = await db.from("integration_secrets").upsert({
    connection_id: connectionId,
    ciphertext: encryptJson(secret),
    expires_at: secret.expires_at ? new Date(secret.expires_at * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`save secret: ${error.message}`);
}

export async function getSecret(db: SupabaseClient, connectionId: string): Promise<StoredSecret> {
  const { data, error } = await db.from("integration_secrets").select("ciphertext").eq("connection_id", connectionId).single();
  if (error || !data) throw new Error("Integration credentials missing — reconnect the integration");
  return decryptJson<StoredSecret>(data.ciphertext);
}

export async function getConnection(db: SupabaseClient, connectionId: string): Promise<ConnectionRow> {
  const { data, error } = await db.from("integration_connections").select("*").eq("id", connectionId).single();
  if (error || !data) throw new Error(`connection ${connectionId} not found`);
  return data as ConnectionRow;
}

export type RefreshFn = (refreshToken: string) => Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>;

/** Valid access token, refreshed (and persisted) when within 2 minutes of expiry. */
export async function getAccessToken(db: SupabaseClient, connectionId: string, refresh?: RefreshFn): Promise<string> {
  const secret = await getSecret(db, connectionId);
  if (secret.api_key) return secret.api_key;
  if (!secret.access_token) throw new Error("No access token stored");
  const expiring = secret.expires_at != null && secret.expires_at - 120 < Date.now() / 1000;
  if (!expiring) return secret.access_token;
  if (!refresh || !secret.refresh_token) throw new Error("Access token expired and cannot be refreshed — reconnect");
  try {
    const t = await refresh(secret.refresh_token);
    const next: StoredSecret = {
      ...secret,
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? secret.refresh_token,
      expires_at: t.expires_in ? Math.floor(Date.now() / 1000) + t.expires_in : undefined,
    };
    await putSecret(db, connectionId, next);
    return next.access_token!;
  } catch (e) {
    await markError(db, connectionId, `Token refresh failed: ${(e as Error).message}`);
    throw e;
  }
}

export async function markError(db: SupabaseClient, connectionId: string, message: string) {
  await db.from("integration_connections").update({ status: "error", error: message.slice(0, 500) }).eq("id", connectionId);
}

export async function markSynced(db: SupabaseClient, connectionId: string, cursor?: Record<string, unknown>) {
  await db
    .from("integration_connections")
    .update({ last_synced_at: new Date().toISOString(), status: "active", error: null, ...(cursor ? { sync_cursor: cursor } : {}) })
    .eq("id", connectionId);
}

/** Small fetch wrapper: JSON in/out, bearer auth, retries 429/5xx with backoff. */
export async function apiFetch<T>(url: string, init: RequestInit & { token?: string; json?: unknown } = {}, attempt = 0): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  const res = await fetch(url, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  // 429 means the request was not processed, so it is always safe to retry.
  // 5xx is retried only for idempotent methods: a POST may already have
  // created the record (e.g. a CRM contact) and retrying would duplicate it.
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "PUT" || method === "DELETE" || method === "HEAD";
  if ((res.status === 429 || (res.status >= 500 && idempotent)) && attempt < 3) {
    const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
    return apiFetch<T>(url, init, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${new URL(url).host}${redactPath(new URL(url).pathname)} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Masks long opaque path segments (tokens, keys) so they never reach logs or error messages. */
export function redactPath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (seg.length >= 24 && /^[A-Za-z0-9._~%+=-]+$/.test(seg) && !/^[a-z-]+$/.test(seg) ? "…" : seg))
    .join("/");
}
