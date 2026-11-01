import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConnection, markError, markSynced, type ConnectionRow } from "@/lib/integrations/connections";
import {
  extractPlainText,
  getMessage,
  gmailAccessToken,
  headerValue,
  isAutoReply,
  isBounceMessage,
  isSystemSender,
  listMessageIds,
  parseAddressList,
  type Address,
  type GmailMessage,
} from "./client";
import { recordBounce, recordReply, type ThreadEnrollment } from "./send";

// gmail.sync — read-only mirror of threads with the workspace's chosen prospects.
//
// Scope (product rule): only mail to/from contacts on QUALIFIED accounts in
// this workspace (or, with settings.prospect_scope === 'owned', accounts owned
// by the connecting member), plus the campaign threads this mailbox started
// (needed to stop sequences on reply/bounce). Other mail is never fetched or
// stored: Gmail is queried by prospect address, and the bounce search only
// returns message/thread ids, of which only campaign-thread ids are fetched.
// Synced mail is never sent to a model or used for ads.
//
// Disconnecting deletes everything stored here (email_messages cascade).

const SYNC_BUDGET_MS = 45_000;
const BACKFILL_DAYS = 90;
const OVERLAP_SECONDS = 10 * 60;
const QUERY_MAX_ADDRESSES = 15;
const QUERY_MAX_ADDRESS_CHARS = 600;
const FETCH_CONCURRENCY = 5;
const PAGE = 1000;

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "yandex.com", "comcast.net",
]);

interface Prospect {
  contactId: string;
  accountId: string | null;
  companyId: string | null;
  name: string;
}

type CampaignThread = ThreadEnrollment;

interface Cursor {
  v: 1;
  after?: number; // epoch seconds; Gmail `after:` accepts seconds
  seen?: string[]; // short hashes of addresses already backfilled
}

export interface SyncSummary {
  prospects: number;
  queries: number;
  matched: number;
  stored: number;
  replies: number;
  bounces: number;
  complete: boolean;
}

const QUERYABLE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function hashEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

function readCursor(raw: Record<string, unknown> | null | undefined): Cursor {
  const after = typeof raw?.after === "number" && Number.isFinite(raw.after) ? raw.after : undefined;
  const seen = Array.isArray(raw?.seen) ? (raw.seen as unknown[]).filter((s): s is string => typeof s === "string") : undefined;
  return { v: 1, after, seen };
}

/**
 * `after:<secs> (from:(a OR b) OR to:(a OR b))`, batched to keep queries short.
 * UNVERIFIED: Gmail documents no maximum `q` length; batches stay at ≤15 addresses / ~1.3k chars.
 */
function buildQueries(emails: string[], after: number): string[] {
  const out: string[] = [];
  let batch: string[] = [];
  let chars = 0;
  const flush = () => {
    if (!batch.length) return;
    const list = batch.join(" OR ");
    out.push(`after:${after} (from:(${list}) OR to:(${list}))`);
    batch = [];
    chars = 0;
  };
  for (const e of emails) {
    if (batch.length >= QUERY_MAX_ADDRESSES || chars + e.length > QUERY_MAX_ADDRESS_CHARS) flush();
    batch.push(e);
    chars += e.length + 4;
  }
  flush();
  return out;
}

/** Contacts on qualified accounts (optionally only the member's own accounts). */
async function loadProspects(db: SupabaseClient, conn: ConnectionRow): Promise<Map<string, Prospect>> {
  const out = new Map<string, Prospect>();
  const ownedOnly = conn.settings?.prospect_scope === "owned";
  if (ownedOnly && !conn.connected_by) return out;
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from("contacts")
      .select("id, email, full_name, account_id, company_id, accounts!inner(research_status, owner_id)")
      .eq("workspace_id", conn.workspace_id)
      .not("email", "is", null)
      .eq("accounts.research_status", "qualified");
    if (ownedOnly) q = q.eq("accounts.owner_id", conn.connected_by!);
    const { data, error } = await q.order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`load prospects: ${error.message}`);
    for (const r of (data ?? []) as { id: string; email: string | null; full_name: string; account_id: string | null; company_id: string | null }[]) {
      const email = r.email?.trim().toLowerCase();
      if (email) out.set(email, { contactId: r.id, accountId: r.account_id, companyId: r.company_id, name: r.full_name });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Threads this mailbox started for campaign enrollments, keyed by Gmail thread id. */
async function loadCampaignThreads(db: SupabaseClient, conn: ConnectionRow): Promise<Map<string, CampaignThread>> {
  const out = new Map<string, CampaignThread>();
  type Row = {
    id: string;
    contact_id: string;
    account_id: string | null;
    campaign_id: string;
    gmail_thread_id: string;
    campaigns: { name: string } | null;
    contacts: { email: string | null; full_name: string; account_id: string | null } | null;
  };
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("campaign_enrollments")
      .select("id, contact_id, account_id, campaign_id, gmail_thread_id, campaigns!inner(name, mailbox_connection_id), contacts!inner(email, full_name, account_id)")
      .eq("workspace_id", conn.workspace_id)
      .eq("campaigns.mailbox_connection_id", conn.id)
      .not("gmail_thread_id", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load campaign threads: ${error.message}`);
    for (const r of (data ?? []) as unknown as Row[]) {
      const email = r.contacts?.email?.trim().toLowerCase();
      if (!email) continue;
      out.set(r.gmail_thread_id, {
        enrollmentId: r.id,
        campaignId: r.campaign_id,
        campaignName: r.campaigns?.name ?? "campaign",
        contactId: r.contact_id,
        accountId: r.account_id ?? r.contacts?.account_id ?? null,
        contactEmail: email,
        contactName: r.contacts?.full_name ?? email,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function filterNew(db: SupabaseClient, connectionId: string, ids: string[]): Promise<string[]> {
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await db.from("email_messages").select("gmail_message_id").eq("connection_id", connectionId).in("gmail_message_id", chunk);
    if (error) throw new Error(`check stored messages: ${error.message}`);
    for (const r of data ?? []) existing.add(r.gmail_message_id as string);
  }
  return ids.filter((id) => !existing.has(id));
}

interface Parsed {
  row: Record<string, unknown>;
  from: Address | null;
  participants: Address[];
  outbound: boolean;
  isBounce: boolean;
  isAuto: boolean;
  thread: CampaignThread | null;
  prospect: Prospect | null;
  sentAt: string | null;
}

function parseMessage(
  msg: GmailMessage,
  ctx: { conn: ConnectionRow; mailbox: string; prospects: Map<string, Prospect>; threads: Map<string, CampaignThread> },
): Parsed | null {
  const headers = msg.payload?.headers;
  const from = parseAddressList(headerValue(headers, "From"))[0] ?? null;
  const to = parseAddressList(headerValue(headers, "To"));
  const cc = parseAddressList(headerValue(headers, "Cc"));
  const subject = headerValue(headers, "Subject");
  const labels = msg.labelIds ?? [];
  const outbound = from?.email === ctx.mailbox || labels.includes("SENT");
  const thread = ctx.threads.get(msg.threadId) ?? null;

  // Defense in depth: store only if a chosen prospect is on the message, or it's one of our campaign threads.
  const recipients = [...to, ...cc];
  const prospect =
    (outbound ? undefined : from ? ctx.prospects.get(from.email) : undefined) ??
    recipients.map((a) => ctx.prospects.get(a.email)).find((p): p is Prospect => Boolean(p)) ??
    (from ? ctx.prospects.get(from.email) : undefined) ??
    null;
  if (!prospect && !thread) return null;

  const isBounce = !outbound && isBounceMessage(from?.email ?? null, subject);
  const sentAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
  const contactId = prospect?.contactId ?? thread?.contactId ?? null;
  const accountId = prospect?.accountId ?? thread?.accountId ?? null;
  return {
    row: {
      workspace_id: ctx.conn.workspace_id,
      connection_id: ctx.conn.id,
      gmail_message_id: msg.id,
      gmail_thread_id: msg.threadId,
      account_id: accountId,
      contact_id: contactId,
      direction: outbound ? "outbound" : "inbound",
      from_email: from?.email ?? null,
      to_emails: to.map((a) => a.email),
      cc_emails: cc.map((a) => a.email),
      subject,
      snippet: msg.snippet ?? null,
      body_text: extractPlainText(msg.payload),
      sent_at: sentAt,
      labels,
      is_bounce: isBounce,
    },
    from,
    participants: [...(from ? [from] : []), ...recipients],
    outbound,
    isBounce,
    isAuto: isAutoReply(headers, subject),
    thread,
    prospect,
    sentAt,
  };
}

export async function syncGmail(db: SupabaseClient, connectionId: string): Promise<SyncSummary | { skipped: string }> {
  const conn = await getConnection(db, connectionId);
  if (conn.provider !== "gmail") throw new Error(`connection ${connectionId} is not a Gmail connection`);
  if (conn.status === "disconnected") return { skipped: "disconnected" };
  try {
    return await runSync(db, conn);
  } catch (e) {
    // Only auth failures flag the connection (that pauses periodic sync + sending until reconnect);
    // transient errors are retried by the job queue. Refresh failures are flagged by getAccessToken.
    const message = (e as Error).message ?? String(e);
    if (/→ (401|403):/.test(message)) await markError(db, conn.id, `Gmail access was revoked or expired — reconnect Gmail (${message.slice(0, 120)})`);
    throw e;
  }
}

async function runSync(db: SupabaseClient, conn: ConnectionRow): Promise<SyncSummary> {
  const started = Date.now();
  const outOfTime = () => Date.now() - started >= SYNC_BUDGET_MS;
  const mailbox = (conn.external_account_id || conn.account_label || "").toLowerCase();
  const token = await gmailAccessToken(db, conn.id);

  const prospects = await loadProspects(db, conn);
  const threads = await loadCampaignThreads(db, conn);
  // Contacts this mailbox emailed through a campaign stay in scope so replies stop their sequence.
  for (const t of threads.values()) {
    if (!prospects.has(t.contactEmail)) {
      prospects.set(t.contactEmail, { contactId: t.contactId, accountId: t.accountId, companyId: null, name: t.contactName });
    }
  }
  prospects.delete(mailbox);

  const summary: SyncSummary = { prospects: prospects.size, queries: 0, matched: 0, stored: 0, replies: 0, bounces: 0, complete: true };
  const cursor = readCursor(conn.sync_cursor);
  const nowSec = Math.floor(Date.now() / 1000);
  const backfillAfter = nowSec - BACKFILL_DAYS * 86_400;
  const seen = new Set(cursor.seen ?? []);
  const emails = [...prospects.keys()].filter((e) => QUERYABLE.test(e) && !e.endsWith(".example"));

  // Addresses seen in earlier syncs: only new mail. New prospects: 90-day backfill.
  const incremental = cursor.after ? emails.filter((e) => seen.has(hashEmail(e))) : [];
  const incSet = new Set(incremental);
  const backfill = emails.filter((e) => !incSet.has(e));
  const queries = [...buildQueries(incremental, cursor.after ?? backfillAfter), ...buildQueries(backfill, backfillAfter)];

  const found = new Map<string, string>(); // message id → thread id
  for (const q of queries) {
    if (outOfTime()) {
      summary.complete = false;
      break;
    }
    summary.queries++;
    for (const m of await listMessageIds(token, q)) found.set(m.id, m.threadId);
  }

  // Bounce notices come from mailer-daemon, not the prospect. The list call returns ids only;
  // only those in our campaign threads are ever fetched.
  // UNVERIFIED: that `from:mailer-daemon` matches partial addresses (mailer-daemon@googlemail.com)
  // and that Gmail files the bounce notice in the original message's thread.
  if (threads.size > 0 && !outOfTime()) {
    summary.queries++;
    const q = `after:${cursor.after ?? backfillAfter} (from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification")`;
    for (const m of await listMessageIds(token, q, 1000)) if (threads.has(m.threadId)) found.set(m.id, m.threadId);
  }
  summary.matched = found.size;

  const pending = await filterNew(db, conn.id, [...found.keys()]);
  const parsed: Parsed[] = [];
  const ctx = { conn, mailbox, prospects, threads };
  for (let i = 0; i < pending.length; i += FETCH_CONCURRENCY) {
    if (outOfTime()) {
      summary.complete = false;
      break;
    }
    const batch = await Promise.all(
      pending.slice(i, i + FETCH_CONCURRENCY).map(async (id) => {
        try {
          return parseMessage(await getMessage(token, id, { format: "full" }), ctx);
        } catch (e) {
          console.error(`[gmail.sync] ${conn.id}: message fetch failed: ${(e as Error).message.slice(0, 200)}`);
          return null;
        }
      }),
    );
    for (const p of batch) if (p) parsed.push(p);
  }

  // Store; events fire only for rows inserted now (so each reply/bounce is handled once).
  const insertedIds = new Map<string, string>(); // gmail id → email_messages.id
  for (let i = 0; i < parsed.length; i += 100) {
    const { data, error } = await db
      .from("email_messages")
      .upsert(
        parsed.slice(i, i + 100).map((p) => p.row),
        { onConflict: "connection_id,gmail_message_id", ignoreDuplicates: true },
      )
      .select("id, gmail_message_id");
    if (error) throw new Error(`store messages: ${error.message}`);
    for (const r of data ?? []) insertedIds.set(r.gmail_message_id as string, r.id as string);
  }
  const stored = parsed.filter((p) => insertedIds.has(p.row.gmail_message_id as string));
  summary.stored = stored.length;

  stored.sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""));
  for (const p of stored) {
    if (!p.thread) continue;
    const emailMessageId = insertedIds.get(p.row.gmail_message_id as string)!;
    if (p.isBounce) {
      if (await recordBounce(db, conn, p.thread, { emailMessageId })) summary.bounces++;
    } else if (!p.outbound && !p.isAuto && p.from && !isSystemSender(p.from.email)) {
      if (await recordReply(db, conn, p.thread, p.from, { emailMessageId, at: p.sentAt })) summary.replies++;
    }
  }

  await upsertNetwork(db, conn, mailbox, stored, prospects);

  if (summary.complete) {
    await markSynced(db, conn.id, { v: 1, after: nowSec - OVERLAP_SECONDS, seen: emails.map(hashEmail) } satisfies Cursor);
  } else {
    await markSynced(db, conn.id); // partial: keep the cursor, next run resumes (stored ids are skipped)
  }
  return summary;
}

/** Network connections for the people in these prospect threads (never the rest of the mailbox). */
async function upsertNetwork(db: SupabaseClient, conn: ConnectionRow, mailbox: string, stored: Parsed[], prospects: Map<string, Prospect>) {
  if (!conn.connected_by || stored.length === 0) return;
  const ownDomain = domainOf(mailbox);
  const agg = new Map<string, { name: string | null; count: number; last: string | null }>();
  for (const p of stored) {
    if (p.isBounce) continue;
    for (const a of p.participants) {
      if (a.email === mailbox || isSystemSender(a.email)) continue;
      if (!FREEMAIL.has(ownDomain) && domainOf(a.email) === ownDomain) continue; // teammates
      const cur = agg.get(a.email) ?? { name: null, count: 0, last: null };
      cur.count++;
      cur.name ??= a.name;
      if (p.sentAt && (!cur.last || p.sentAt > cur.last)) cur.last = p.sentAt;
      agg.set(a.email, cur);
    }
  }
  const keys = [...agg.keys()];
  if (keys.length === 0) return;

  const existing = new Map<string, { interactions: number; last_interaction_at: string | null; full_name: string }>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data } = await db
      .from("network_connections")
      .select("identity_key, interactions, last_interaction_at, full_name")
      .eq("workspace_id", conn.workspace_id)
      .eq("member_id", conn.connected_by)
      .eq("source", "gmail")
      .in("identity_key", keys.slice(i, i + 200));
    for (const r of data ?? []) existing.set(r.identity_key as string, r as { interactions: number; last_interaction_at: string | null; full_name: string });
  }

  const rows = keys.map((email) => {
    const a = agg.get(email)!;
    const prev = existing.get(email);
    const prospect = prospects.get(email);
    const domain = domainOf(email);
    const last = [a.last, prev?.last_interaction_at ?? null].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
    return {
      workspace_id: conn.workspace_id,
      member_id: conn.connected_by,
      source: "gmail",
      identity_key: email,
      email,
      full_name: prospect?.name ?? a.name ?? prev?.full_name ?? email.slice(0, email.indexOf("@")),
      company_domain: FREEMAIL.has(domain) ? null : domain,
      company_id: prospect?.companyId ?? null,
      interactions: (prev?.interactions ?? 0) + a.count,
      last_interaction_at: last,
    };
  });
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("network_connections").upsert(rows.slice(i, i + 200), { onConflict: "workspace_id,member_id,source,identity_key" });
    if (error) console.error(`[gmail.sync] network upsert: ${error.message}`);
  }
}
