import type { SupabaseClient } from "@supabase/supabase-js";
import { apiFetch, getConnection, getSecret, markError, saveConnection } from "@/lib/integrations/connections";
import { signToken, verifyToken } from "@/lib/crypto";
import { publicEnv } from "@/lib/env";
import { enqueue, type JobPayloads } from "@/lib/jobs";
import { draftEmail } from "@/lib/outreach/draft";

// ── Instantly (API v2) ──────────────────────────────────────────────────────
//
// Tidemark never sends through Instantly. It adds each prospect as a lead to
// the Instantly campaign the user picked, with a first email drafted from that
// prospect's signals stored as lead custom variables. The user's Instantly
// campaign sends it from their own mailboxes. Reference these in the Instantly
// campaign's step-1 template:
//
//   {{tidemark_subject}}        drafted subject line (plain text)
//   {{tidemark_body}}           drafted body (plain text; paragraphs separated by blank lines)
//   {{tidemark_body_html}}      the same body, HTML-escaped with <br> line breaks
//                               // UNVERIFIED: whether Instantly inserts variable values raw
//                               // (so <br> renders) or escapes them; use tidemark_body if unsure.
//   {{tidemark_enrollment_id}}  Tidemark's enrollment id (for webhook mapping; don't render it)
//
// Endpoints (base https://api.instantly.ai/api/v2, `Authorization: Bearer <key>`),
// checked against developer.instantly.ai on 2026-11-01:
//   GET    /workspaces/current                       validate key; stable workspace id + name
//   GET    /campaigns?limit=100&starting_after=…     campaign picker ({items, next_starting_after})
//   POST   /leads/list   {campaign, contacts[]}      leads already in the campaign (retry-safe push)
//   POST   /leads/add    {campaign_id, leads[]}      bulk add (≤1000); returns created_leads[{index,id,email}]
//   POST   /webhooks     {target_hook_url, event_type:"all_events", name}
//   DELETE /webhooks/{id}
//
// Webhook events acted on (payload: timestamp, event_type, workspace,
// campaign_id, campaign_name, lead_email, email_id, reply_* …):
//   reply_received       → enrollment stopped_reply + follow-up task + activity
//   email_bounced        → enrollment stopped_bounce + suppression 'bounce' + activity
//   lead_unsubscribed    → enrollment stopped_unsubscribe + suppression 'unsubscribe'
//                          + contacts.unsubscribed_at + activity
//   email_opened, link_clicked / email_link_clicked, auto_reply_received → activity only
// (The docs' event guide says `link_clicked`; the create-webhook enum says
// `email_link_clicked`. Both are accepted.) Everything else is acknowledged and ignored.

const API = "https://api.instantly.ai/api/v2";

export const INSTANTLY_VARS = {
  subject: "tidemark_subject",
  body: "tidemark_body",
  bodyHtml: "tidemark_body_html",
  enrollmentId: "tidemark_enrollment_id",
} as const;

/** integration_connections.settings key holding the registered webhook's id. */
export const INSTANTLY_WEBHOOK_SETTING = "instantly_webhook_id";

const WEBHOOK_TOKEN_PURPOSE = "instantly_webhook";
const WEBHOOK_TOKEN_TTL = 10 * 365 * 24 * 60 * 60; // the URL lives as long as the connection

const CAMPAIGN_STATUS: Record<number, string> = {
  0: "draft",
  1: "active",
  2: "paused",
  3: "completed",
  4: "running_subsequences",
  [-1]: "accounts_unhealthy",
  [-2]: "bounce_protect",
  [-99]: "account_suspended",
};

// Keep each push run short: the worker tick has a 60 s ceiling (maxDuration),
// so anything left over is re-enqueued as a continuation job.
const PUSH_BUDGET_MS = 25_000;
const PUSH_BATCH = 4;

// ── HTTP ────────────────────────────────────────────────────────────────────

function httpStatus(e: unknown): number | null {
  const m = /→ (\d{3}):/.exec((e as Error)?.message ?? "");
  return m ? Number(m[1]) : null;
}

function describeError(e: unknown, doing: string): string {
  const s = httpStatus(e);
  if (s === 401 || s === 403) return "Instantly rejected this API key. Create a key with access to campaigns, leads and webhooks.";
  if (s === 402) return "This Instantly workspace has no active paid plan.";
  if (s === 429) return "Instantly is rate limiting requests. Try again in a minute.";
  if (s === null) return `Could not reach Instantly to ${doing}.`;
  return `Instantly returned an error (${s}) while trying to ${doing}.`;
}

function instantly<T>(apiKey: string, path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  return apiFetch<T>(`${API}${path}`, { method: init.method ?? "GET", json: init.json, token: apiKey });
}

/** Stored-key call: a 401 flags the connection so the UI asks for a reconnect. */
async function callStored<T>(db: SupabaseClient, connectionId: string, apiKey: string, path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  try {
    return await instantly<T>(apiKey, path, init);
  } catch (e) {
    if (httpStatus(e) === 401) await markError(db, connectionId, "Instantly rejected the stored API key. Reconnect Instantly.");
    throw e;
  }
}

async function storedApiKey(db: SupabaseClient, connectionId: string): Promise<string> {
  const secret = await getSecret(db, connectionId);
  if (!secret.api_key) throw new Error("Instantly API key missing. Reconnect Instantly.");
  return secret.api_key;
}

// ── Key validation + connect ────────────────────────────────────────────────

export type InstantlyKeyCheck =
  | { ok: true; externalAccountId: string; label: string | null }
  | { ok: false; error: string };

/** Cheap read to prove the key works. Prefers the workspace (stable id); falls back to listing campaigns. */
export async function validateInstantlyKey(apiKey: string): Promise<InstantlyKeyCheck> {
  try {
    const ws = await instantly<{ id?: string; name?: string }>(apiKey, "/workspaces/current");
    return { ok: true, externalAccountId: ws.id || "default", label: ws.name ?? null };
  } catch (first) {
    if (httpStatus(first) === 402) return { ok: false, error: describeError(first, "validate the key") };
    // The key may simply lack the workspaces:read scope; campaigns:read is what we need anyway.
    try {
      await instantly<unknown>(apiKey, "/campaigns?limit=1");
      return { ok: true, externalAccountId: "default", label: null };
    } catch (e) {
      return { ok: false, error: describeError(e, "validate the key") };
    }
  }
}

/** Public URL Instantly posts events to, authenticated by a signed token naming the connection. */
export function instantlyWebhookUrl(connectionId: string): string {
  const t = signToken({ cid: connectionId, p: WEBHOOK_TOKEN_PURPOSE }, WEBHOOK_TOKEN_TTL);
  return `${publicEnv.appUrl().replace(/\/+$/, "")}/api/webhooks/instantly?t=${encodeURIComponent(t)}`;
}

/** Connection id from a webhook `?t=` token, or null when missing / forged / expired. */
export function readInstantlyWebhookToken(token: string | null): string | null {
  if (!token) return null;
  const data = verifyToken<{ cid?: unknown; p?: unknown }>(token);
  return data && data.p === WEBHOOK_TOKEN_PURPOSE && typeof data.cid === "string" ? data.cid : null;
}

export async function registerInstantlyWebhook(apiKey: string, connectionId: string): Promise<string> {
  const hook = await instantly<{ id: string }>(apiKey, "/webhooks", {
    method: "POST",
    json: { target_hook_url: instantlyWebhookUrl(connectionId), event_type: "all_events", name: "Tidemark" },
  });
  if (!hook?.id) throw new Error("Instantly did not return a webhook id");
  return hook.id;
}

export async function deleteInstantlyWebhook(apiKey: string, webhookId: string): Promise<void> {
  try {
    await instantly<unknown>(apiKey, `/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" });
  } catch (e) {
    if (httpStatus(e) !== 404) throw e;
  }
}

/**
 * Best-effort removal of the Instantly webhook for a connection. Call this
 * BEFORE deleting the connection row (the API key is deleted with it).
 */
export async function unregisterInstantlyWebhook(db: SupabaseClient, connectionId: string): Promise<void> {
  try {
    const conn = await getConnection(db, connectionId);
    const hookId = conn.settings?.[INSTANTLY_WEBHOOK_SETTING];
    if (typeof hookId !== "string") return;
    await deleteInstantlyWebhook(await storedApiKey(db, connectionId), hookId);
  } catch {
    // Disconnect must not fail because Instantly is unreachable; a stale hook
    // only reaches a token whose connection no longer exists and is ignored.
  }
}

export type ConnectResult = { ok: true; connectionId: string } | { ok: false; error: string };

/**
 * Validate → save (encrypted key) → register the webhook → remember its id.
 * Caller must already have checked the user is a workspace admin.
 */
export async function connectInstantly(
  db: SupabaseClient,
  p: { workspaceId: string; userId: string; apiKey: string },
): Promise<ConnectResult> {
  const check = await validateInstantlyKey(p.apiKey);
  if (!check.ok) return check;

  const { data: prior } = await db
    .from("integration_connections")
    .select("id, settings")
    .eq("workspace_id", p.workspaceId)
    .eq("provider", "instantly")
    .eq("external_account_id", check.externalAccountId)
    .maybeSingle();
  const priorSettings = ((prior?.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;

  const conn = await saveConnection(db, {
    workspaceId: p.workspaceId,
    provider: "instantly",
    externalAccountId: check.externalAccountId,
    accountLabel: check.label ?? "Instantly",
    settings: priorSettings,
    connectedBy: p.userId,
    secret: { api_key: p.apiKey },
  });

  // Reconnecting: replace the old webhook instead of stacking a second one.
  const oldHook = priorSettings[INSTANTLY_WEBHOOK_SETTING];
  if (typeof oldHook === "string") await deleteInstantlyWebhook(p.apiKey, oldHook).catch(() => undefined);

  let hookId: string | null = null;
  try {
    hookId = await registerInstantlyWebhook(p.apiKey, conn.id);
    const { error } = await db
      .from("integration_connections")
      .update({ settings: { ...priorSettings, [INSTANTLY_WEBHOOK_SETTING]: hookId, instantly_workspace_name: check.label } })
      .eq("id", conn.id);
    if (error) throw new Error(`save webhook id: ${error.message}`);
  } catch (e) {
    if (hookId) await deleteInstantlyWebhook(p.apiKey, hookId).catch(() => undefined);
    // A brand-new connection without a webhook would never hear outcomes: undo it
    // (integration_secrets cascades). An existing one is flagged instead.
    if (!prior) await db.from("integration_connections").delete().eq("id", conn.id);
    else await markError(db, conn.id, "Could not register the Instantly webhook. Reconnect Instantly.");
    return {
      ok: false,
      error: httpStatus(e) !== null ? describeError(e, "register the webhook") : "Could not register the Instantly webhook. Try again.",
    };
  }
  return { ok: true, connectionId: conn.id };
}

// ── Campaign picker ─────────────────────────────────────────────────────────

interface InstantlyCampaign {
  id: string;
  name: string;
  status: number;
}

export async function listInstantlyCampaigns(db: SupabaseClient, connectionId: string): Promise<{ id: string; name: string; status: string }[]> {
  const apiKey = await storedApiKey(db, connectionId);
  const out: { id: string; name: string; status: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (after) q.set("starting_after", after);
    const res = await callStored<{ items?: InstantlyCampaign[]; next_starting_after?: string | null }>(db, connectionId, apiKey, `/campaigns?${q}`);
    const items = res.items ?? [];
    for (const c of items) out.push({ id: c.id, name: c.name, status: CAMPAIGN_STATUS[c.status] ?? String(c.status) });
    if (!res.next_starting_after || items.length === 0) break;
    after = res.next_starting_after;
  }
  return out;
}

// ── Push (job "instantly.push") ─────────────────────────────────────────────

interface PushContact {
  id: string;
  email: string | null;
  email_status: string;
  unsubscribed_at: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  title: string | null;
  account_id: string | null;
  companies: { name: string | null; domain: string | null } | null;
}

interface PushEnrollment {
  id: string;
  contact_id: string;
  account_id: string | null;
  status: string;
  external_lead_id: string | null;
  enrolled_by: string | null;
  contacts: PushContact | null;
}

interface Eligible {
  enrollment: PushEnrollment;
  contact: PushContact;
  email: string;
  accountId: string;
}

interface AddLeadsResponse {
  leads_uploaded?: number;
  in_blocklist?: number;
  created_leads?: { index?: number; id: string; email?: string | null }[];
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function splitName(c: PushContact): { first: string | null; last: string | null } {
  if (c.first_name || c.last_name) return { first: c.first_name, last: c.last_name };
  const parts = c.full_name.trim().split(/\s+/);
  return { first: parts[0] ?? null, last: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

function skipReason(e: PushEnrollment, suppressed: Map<string, string>): string | null {
  const c = e.contacts;
  if (!c) return "contact missing";
  const email = c.email?.trim().toLowerCase();
  if (!email) return "no email address";
  if (email.endsWith(".example")) return "demo contact";
  if (c.unsubscribed_at) return "unsubscribed";
  const s = suppressed.get(email);
  if (s) return `suppressed (${s})`;
  if (c.email_status === "invalid") return "invalid email";
  if (!(e.account_id ?? c.account_id)) return "no account";
  return null;
}

async function failEnrollment(db: SupabaseClient, id: string, reason: string) {
  const { error } = await db
    .from("campaign_enrollments")
    .update({ status: "failed", stop_reason: reason.slice(0, 300), stopped_at: new Date().toISOString(), next_send_at: null })
    .eq("id", id)
    .eq("status", "active");
  if (error) throw new Error(`mark enrollment failed: ${error.message}`);
}

export async function pushToInstantly(db: SupabaseClient, p: JobPayloads["instantly.push"]) {
  const started = Date.now();
  const { data: campaign, error: campErr } = await db
    .from("campaigns")
    .select("id, workspace_id, name, instantly_connection_id, instantly_campaign_id")
    .eq("id", p.campaignId)
    .maybeSingle();
  if (campErr) throw new Error(`load campaign: ${campErr.message}`);
  if (!campaign) return { skipped: "campaign not found" };
  if (!campaign.instantly_connection_id || !campaign.instantly_campaign_id) {
    throw new Error("Campaign is not linked to an Instantly campaign");
  }
  const conn = await getConnection(db, campaign.instantly_connection_id);
  if (conn.provider !== "instantly" || conn.workspace_id !== campaign.workspace_id) {
    throw new Error("Instantly connection does not belong to this campaign's workspace");
  }
  if (conn.status === "disconnected") throw new Error("Instantly is disconnected");
  const apiKey = await storedApiKey(db, conn.id);
  const instantlyCampaignId = campaign.instantly_campaign_id as string;

  const { data: step0 } = await db
    .from("campaign_steps")
    .select("body_template")
    .eq("campaign_id", campaign.id)
    .eq("position", 0)
    .maybeSingle();

  // Enrollments named in the job (chunked to keep the query string short).
  const rows: PushEnrollment[] = [];
  for (const ids of chunk([...new Set(p.enrollmentIds)], 100)) {
    const { data, error } = await db
      .from("campaign_enrollments")
      .select(
        "id, contact_id, account_id, status, external_lead_id, enrolled_by, " +
          "contacts(id, email, email_status, unsubscribed_at, first_name, last_name, full_name, title, account_id, companies(name, domain))",
      )
      .eq("campaign_id", campaign.id)
      .in("id", ids);
    if (error) throw new Error(`load enrollments: ${error.message}`);
    rows.push(...((data ?? []) as unknown as PushEnrollment[]));
  }
  const pending = rows.filter((r) => r.status === "active" && !r.external_lead_id);

  const emails = [...new Set(pending.map((r) => r.contacts?.email?.trim().toLowerCase()).filter((e): e is string => !!e))];
  const suppressed = new Map<string, string>();
  for (const part of chunk(emails, 100)) {
    const { data, error } = await db.from("suppressions").select("email, reason").eq("workspace_id", campaign.workspace_id).in("email", part);
    if (error) throw new Error(`load suppressions: ${error.message}`);
    for (const s of data ?? []) suppressed.set(String(s.email).toLowerCase(), String(s.reason));
  }

  let skipped = 0;
  const eligible: Eligible[] = [];
  for (const e of pending) {
    const reason = skipReason(e, suppressed);
    if (reason) {
      await failEnrollment(db, e.id, reason);
      skipped++;
      continue;
    }
    const contact = e.contacts!;
    eligible.push({ enrollment: e, contact, email: contact.email!.trim().toLowerCase(), accountId: (e.account_id ?? contact.account_id)! });
  }

  let pushed = 0;
  let linkedExisting = 0;
  let failed = 0;
  let remaining: string[] = [];

  const link = async (item: Eligible, leadId: string, draft: { subject: string; body: string } | null) => {
    const { error } = await db
      .from("campaign_enrollments")
      .update({ external_lead_id: leadId, current_step: 0 })
      .eq("id", item.enrollment.id);
    if (error) throw new Error(`save Instantly lead id: ${error.message}`);
    await db.from("activities").insert({
      workspace_id: campaign.workspace_id,
      account_id: item.accountId,
      contact_id: item.contact.id,
      actor_id: item.enrollment.enrolled_by,
      kind: "campaign_enrolled",
      title: `Added to Instantly campaign "${campaign.name}"`,
      body: draft ? `First email: ${draft.subject}` : null,
      data: {
        source: "instantly",
        campaign_id: campaign.id,
        enrollment_id: item.enrollment.id,
        instantly_campaign_id: instantlyCampaignId,
        instantly_lead_id: leadId,
        ...(draft ? { subject: draft.subject, body: draft.body } : { already_in_campaign: true }),
      },
    });
  };

  for (let i = 0; i < eligible.length; i += PUSH_BATCH) {
    if (Date.now() - started > PUSH_BUDGET_MS) {
      remaining = eligible.slice(i).map((x) => x.enrollment.id);
      break;
    }
    const batch = eligible.slice(i, i + PUSH_BATCH);

    // 1. Already in the Instantly campaign (an earlier run crashed after the
    //    add, or the user added them by hand): link instead of adding twice.
    const existing = await findCampaignLeads(db, conn.id, apiKey, instantlyCampaignId, batch.map((b) => b.email));
    const toDraft: Eligible[] = [];
    for (const item of batch) {
      const leadId = existing.get(item.email);
      if (leadId) {
        await link(item, leadId, null);
        linkedExisting++;
      } else toDraft.push(item);
    }
    if (toDraft.length === 0) continue;

    // 2. Draft the first email from each prospect's signals.
    const drafted = await Promise.all(
      toDraft.map(async (item) => {
        try {
          const d = await draftEmail(db, {
            accountId: item.accountId,
            contactId: item.contact.id,
            stepPosition: 0,
            guidance: (step0?.body_template as string | null | undefined) ?? null,
          });
          return { item, draft: d, error: null as string | null };
        } catch (e) {
          return { item, draft: null, error: (e as Error).message };
        }
      }),
    );
    const draftErrors = drafted.filter((d) => !d.draft);
    if (draftErrors.length === drafted.length) {
      // Systemic (model down / misconfigured): let the job retry with backoff.
      // Finished enrollments are skipped on retry (external_lead_id / status).
      throw new Error(`Drafting failed for every contact in the batch: ${draftErrors[0].error}`);
    }
    for (const d of draftErrors) {
      await failEnrollment(db, d.item.enrollment.id, `draft failed: ${d.error}`);
      failed++;
    }
    const ready = drafted.filter((d): d is { item: Eligible; draft: { subject: string; body: string }; error: null } => !!d.draft);

    // 3. Add to the campaign with the draft as custom variables.
    const leads = ready.map(({ item, draft }) => {
      const name = splitName(item.contact);
      return {
        email: item.email,
        first_name: name.first,
        last_name: name.last,
        company_name: item.contact.companies?.name ?? null,
        job_title: item.contact.title ?? null,
        website: item.contact.companies?.domain ?? null,
        custom_variables: {
          [INSTANTLY_VARS.subject]: draft.subject,
          [INSTANTLY_VARS.body]: draft.body,
          [INSTANTLY_VARS.bodyHtml]: escapeHtml(draft.body).replace(/\r?\n/g, "<br>"),
          [INSTANTLY_VARS.enrollmentId]: item.enrollment.id,
        },
      };
    });
    const res = await callStored<AddLeadsResponse>(db, conn.id, apiKey, "/leads/add", {
      method: "POST",
      json: { campaign_id: instantlyCampaignId, leads },
    });
    const byIndex = new Map<number, string>();
    const byEmail = new Map<string, string>();
    for (const l of res.created_leads ?? []) {
      if (typeof l.index === "number") byIndex.set(l.index, l.id);
      if (l.email) byEmail.set(l.email.toLowerCase(), l.id);
    }

    const unmatched: { item: Eligible; draft: { subject: string; body: string } }[] = [];
    for (const [idx, r] of ready.entries()) {
      const leadId = byEmail.get(r.item.email) ?? byIndex.get(idx);
      if (leadId) {
        await link(r.item, leadId, r.draft);
        pushed++;
      } else unmatched.push(r);
    }

    // 4. Not created: maybe Instantly treated it as a duplicate of a lead that
    //    is in the campaign after all; otherwise it was blocklisted / invalid.
    if (unmatched.length) {
      const again = await findCampaignLeads(db, conn.id, apiKey, instantlyCampaignId, unmatched.map((u) => u.item.email));
      for (const u of unmatched) {
        const leadId = again.get(u.item.email);
        if (leadId) {
          await link(u.item, leadId, u.draft);
          pushed++;
        } else {
          await failEnrollment(
            db,
            u.item.enrollment.id,
            (res.in_blocklist ?? 0) > 0 ? "rejected by Instantly (blocklist)" : "rejected by Instantly (invalid, blocklisted or duplicate)",
          );
          failed++;
        }
      }
    }
  }

  if (remaining.length) {
    await enqueue("instantly.push", { campaignId: campaign.id, enrollmentIds: remaining }, { workspaceId: campaign.workspace_id, priority: 60 });
  }
  return { pushed, linkedExisting, skipped, failed, continued: remaining.length };
}

async function findCampaignLeads(
  db: SupabaseClient,
  connectionId: string,
  apiKey: string,
  campaignId: string,
  emails: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (emails.length === 0) return out;
  const res = await callStored<{ items?: { id: string; email?: string | null }[] }>(db, connectionId, apiKey, "/leads/list", {
    method: "POST",
    json: { campaign: campaignId, contacts: emails, limit: 100 },
  });
  const wanted = new Set(emails);
  for (const l of res.items ?? []) {
    const e = l.email?.toLowerCase();
    if (e && wanted.has(e) && !out.has(e)) out.set(e, l.id);
  }
  return out;
}

// ── Webhook events ──────────────────────────────────────────────────────────

type Outcome = "reply" | "auto_reply" | "bounce" | "unsubscribe" | "open" | "click";

const EVENT_OUTCOME: Record<string, Outcome> = {
  reply_received: "reply",
  auto_reply_received: "auto_reply",
  email_bounced: "bounce",
  lead_unsubscribed: "unsubscribe",
  email_opened: "open",
  link_clicked: "click",
  email_link_clicked: "click",
};

const ACTIVITY_KIND: Record<Outcome, string> = {
  reply: "reply",
  auto_reply: "email_auto_reply",
  bounce: "email_bounced",
  unsubscribe: "unsubscribed",
  open: "email_opened",
  click: "email_clicked",
};

interface EnrollmentHit {
  id: string;
  status: string;
  contact_id: string;
  account_id: string | null;
  enrolled_by: string | null;
  campaigns: { id: string; name: string; created_by: string | null };
}

const ENROLLMENT_SELECT = "id, status, contact_id, account_id, enrolled_by, campaigns!inner(id, name, created_by, instantly_connection_id)";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function findEnrollment(
  db: SupabaseClient,
  conn: { id: string; workspace_id: string },
  ev: Record<string, unknown>,
  email: string | null,
): Promise<EnrollmentHit | null> {
  const scoped = () =>
    db
      .from("campaign_enrollments")
      .select(ENROLLMENT_SELECT)
      .eq("workspace_id", conn.workspace_id)
      .eq("campaigns.instantly_connection_id", conn.id);

  // UNVERIFIED: Instantly documents no lead id in webhook payloads, only that
  // "extra keys merged from your database may appear" — so a `lead_id` or our
  // own `tidemark_enrollment_id` custom variable may or may not be present.
  const leadId = str(ev.lead_id);
  if (leadId) {
    const { data } = await scoped().eq("external_lead_id", leadId).limit(1);
    if (data?.length) return data[0] as unknown as EnrollmentHit;
  }
  const enrollmentId = str(ev[INSTANTLY_VARS.enrollmentId]);
  if (enrollmentId && /^[0-9a-f-]{36}$/i.test(enrollmentId)) {
    const { data } = await scoped().eq("id", enrollmentId).limit(1);
    if (data?.length) return data[0] as unknown as EnrollmentHit;
  }

  // Documented path: Instantly campaign id + lead email.
  const instantlyCampaignId = str(ev.campaign_id);
  if (!instantlyCampaignId || !email) return null;
  const { data: camps, error } = await db
    .from("campaigns")
    .select("id")
    .eq("workspace_id", conn.workspace_id)
    .eq("instantly_connection_id", conn.id)
    .eq("instantly_campaign_id", instantlyCampaignId);
  if (error) throw new Error(`find campaign: ${error.message}`);
  if (!camps?.length) return null;
  const { data, error: enrErr } = await db
    .from("campaign_enrollments")
    .select(`${ENROLLMENT_SELECT}, contacts!inner(email)`)
    .in("campaign_id", camps.map((c) => c.id as string))
    .eq("contacts.email", email)
    .order("created_at", { ascending: false })
    .limit(1);
  if (enrErr) throw new Error(`find enrollment: ${enrErr.message}`);
  return data?.length ? (data[0] as unknown as EnrollmentHit) : null;
}

async function stopEnrollment(db: SupabaseClient, id: string, status: string, reason: string): Promise<boolean> {
  const { data, error } = await db
    .from("campaign_enrollments")
    .update({ status, stop_reason: reason, stopped_at: new Date().toISOString(), next_send_at: null })
    .eq("id", id)
    .in("status", ["active", "completed"])
    .select("id");
  if (error) throw new Error(`stop enrollment: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

async function suppress(db: SupabaseClient, workspaceId: string, email: string, reason: "bounce" | "unsubscribe") {
  const { error } = await db
    .from("suppressions")
    .upsert({ workspace_id: workspaceId, email, reason, source: "instantly" }, { onConflict: "workspace_id,email", ignoreDuplicates: true });
  if (error) throw new Error(`suppress: ${error.message}`);
}

export type WebhookResult =
  | { ok: true; ignored: string }
  | { ok: true; duplicate: true }
  | { ok: true; outcome: Outcome; enrollmentId: string | null; changed: boolean };

/** Applies one Instantly webhook event. Safe to call repeatedly with the same payload. */
export async function handleInstantlyWebhook(db: SupabaseClient, connectionId: string, raw: unknown): Promise<WebhookResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: true, ignored: "bad payload" };
  const ev = raw as Record<string, unknown>;
  const eventType = str(ev.event_type) ?? "";
  const outcome = EVENT_OUTCOME[eventType];
  if (!outcome) return { ok: true, ignored: `event ${eventType || "unknown"}` };

  const { data: conn, error: connErr } = await db
    .from("integration_connections")
    .select("id, workspace_id, provider, status")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) throw new Error(`load connection: ${connErr.message}`);
  if (!conn || conn.provider !== "instantly" || conn.status === "disconnected") return { ok: true, ignored: "unknown connection" };
  const ws = conn.workspace_id as string;

  const email = str(ev.lead_email)?.toLowerCase() ?? null;
  const enrollment = await findEnrollment(db, { id: conn.id as string, workspace_id: ws }, ev, email);

  const contactQuery = db.from("contacts").select("id, full_name, email, account_id").eq("workspace_id", ws);
  const { data: contact } = enrollment
    ? await contactQuery.eq("id", enrollment.contact_id).maybeSingle()
    : email
      ? await contactQuery.eq("email", email).limit(1).maybeSingle()
      : { data: null };
  const leadEmail = email ?? (contact?.email ? String(contact.email).toLowerCase() : null);

  // Suppression is workspace-wide and idempotent, so it applies even when the
  // event is for an Instantly campaign Tidemark didn't enroll this lead in.
  if (leadEmail && outcome === "bounce") {
    await suppress(db, ws, leadEmail, "bounce");
    await db.from("contacts").update({ email_status: "invalid" }).eq("workspace_id", ws).eq("email", leadEmail);
  }
  if (leadEmail && outcome === "unsubscribe") {
    await suppress(db, ws, leadEmail, "unsubscribe");
    await db.from("contacts").update({ unsubscribed_at: new Date().toISOString() }).eq("workspace_id", ws).eq("email", leadEmail).is("unsubscribed_at", null);
  }

  // Engagement events only matter for leads Tidemark enrolled.
  const needsEnrollment = outcome === "reply" || outcome === "auto_reply" || outcome === "open" || outcome === "click";
  if (needsEnrollment && !enrollment) return { ok: true, ignored: "no matching enrollment" };
  if (!enrollment && !contact) return { ok: true, outcome, enrollmentId: null, changed: false };

  // Idempotency: one activity per distinct event (Instantly may redeliver).
  const eventKey = [eventType, str(ev.campaign_id) ?? "", leadEmail ?? "", str(ev.email_id) ?? "", str(ev.timestamp) ?? ""].join("|");
  const { data: seen, error: seenErr } = await db
    .from("activities")
    .select("id")
    .eq("workspace_id", ws)
    .eq("kind", ACTIVITY_KIND[outcome])
    .contains("data", { instantly_event_key: eventKey })
    .limit(1);
  if (seenErr) throw new Error(`dedupe check: ${seenErr.message}`);
  if (seen?.length) return { ok: true, duplicate: true };

  let changed = false;
  if (enrollment) {
    if (outcome === "reply") changed = await stopEnrollment(db, enrollment.id, "stopped_reply", "reply");
    if (outcome === "bounce") changed = await stopEnrollment(db, enrollment.id, "stopped_bounce", "bounce");
    if (outcome === "unsubscribe") changed = await stopEnrollment(db, enrollment.id, "stopped_unsubscribe", "unsubscribe");
  }

  const accountId = enrollment?.account_id ?? (contact?.account_id as string | null) ?? null;
  const contactId = (contact?.id as string | undefined) ?? enrollment?.contact_id ?? null;
  const name = (contact?.full_name as string | undefined) ?? leadEmail ?? "A prospect";
  const campaignName = enrollment?.campaigns.name ?? str(ev.campaign_name) ?? "Instantly campaign";
  const occurredAt = str(ev.timestamp) && !Number.isNaN(Date.parse(String(ev.timestamp))) ? new Date(String(ev.timestamp)).toISOString() : new Date().toISOString();
  const replyText = str(ev.reply_text_snippet) ?? str(ev.reply_text);

  if (outcome === "reply") {
    const { error } = await db.from("tasks").insert({
      workspace_id: ws,
      account_id: accountId,
      contact_id: contactId,
      assignee_id: enrollment?.campaigns.created_by ?? enrollment?.enrolled_by ?? null,
      title: `Reply from ${name}`,
      description: [replyText ? `"${replyText.slice(0, 500)}"` : null, str(ev.unibox_url) ? `Open in Instantly: ${str(ev.unibox_url)}` : null]
        .filter(Boolean)
        .join("\n\n") || null,
      kind: "follow_up",
      source: "system",
      due_on: new Date().toISOString().slice(0, 10),
    });
    // 23505: an open system follow-up already exists for this account.
    if (error && error.code !== "23505") throw new Error(`create task: ${error.message}`);
  }

  const titles: Record<Outcome, string> = {
    reply: `${name} replied to "${campaignName}"`,
    auto_reply: `Auto-reply from ${name}`,
    bounce: `Email to ${name} bounced`,
    unsubscribe: `${name} unsubscribed`,
    open: `${name} opened an email from "${campaignName}"`,
    click: `${name} clicked a link in "${campaignName}"`,
  };
  const { error: actErr } = await db.from("activities").insert({
    workspace_id: ws,
    account_id: accountId,
    contact_id: contactId,
    kind: ACTIVITY_KIND[outcome],
    title: titles[outcome],
    body: outcome === "reply" || outcome === "auto_reply" ? (replyText?.slice(0, 2000) ?? null) : null,
    data: {
      source: "instantly",
      instantly_event_key: eventKey,
      event_type: eventType,
      enrollment_id: enrollment?.id ?? null,
      campaign_id: enrollment?.campaigns.id ?? null,
      instantly_campaign_id: str(ev.campaign_id),
      step: typeof ev.step === "number" ? ev.step : null,
      subject: str(ev.reply_subject) ?? str(ev.email_subject),
      unibox_url: str(ev.unibox_url),
    },
    occurred_at: occurredAt,
  });
  if (actErr) throw new Error(`record activity: ${actErr.message}`);

  return { ok: true, outcome, enrollmentId: enrollment?.id ?? null, changed };
}
