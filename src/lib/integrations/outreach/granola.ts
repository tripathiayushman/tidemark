import type { SupabaseClient } from "@supabase/supabase-js";
import { apiFetch, getConnection, getSecret, markError, markSynced, saveConnection, type ConnectionRow } from "@/lib/integrations/connections";
import { serverEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { normalizeDomain } from "@/lib/pipeline/normalize";
import { identityKey } from "@/lib/pipeline/warm-paths";

// ── Granola (read-only) ─────────────────────────────────────────────────────
//
// Granola has a documented public REST API (docs.granola.ai, API v1.6.0,
// checked 2026-11-01):
//   base   serverEnv.granolaApiBase()  (default https://public-api.granola.ai/v1)
//   auth   `Authorization: Bearer grn_…` — personal keys: any workspace member
//          on a Business plan; workspace keys: admins (Business/Enterprise)
//   GET /notes?updated_after&cursor&page_size(1-30)
//        → {notes:[{id,title,owner,created_at,updated_at,deleted_at}], hasMore, cursor}
//   GET /notes/{id}
//        → attendees[{name,email}], calendar_event{invitees[{email}], scheduled_start_time,
//          scheduled_end_time, event_title}, summary_text, summary_markdown, web_url
//   GET /notes/{id}/transcript?cursor&page_size(1-100)
//        → {transcript:[{speaker{source,attribution?,name?,diarization_label?},text,start_time,end_time}], hasMore, cursor}
//   Only notes with a generated AI summary + transcript are listed.
//   Rate limit: 5 req/s sustained, 25 per 5 s burst (429 beyond).
//
// Privacy rule: Tidemark reads a note's attendees first and only fetches the
// transcript — and only stores the meeting — when an attendee's email matches
// a contact on one of the workspace's accounts. Only GET requests are made;
// nothing in Granola is ever changed.

const MIN_GAP_MS = 220; // stay under 5 req/s
const SYNC_BUDGET_MS = 25_000; // worker tick ceiling is 60 s; continue in a follow-up job
const MAX_LIST_PAGES = 40; // 40 × 30 notes per run, at most
const BACKFILL_DAYS = 30;

interface GranolaUser {
  name: string | null;
  email: string;
}

interface NoteSummary {
  id: string;
  title: string | null;
  owner: GranolaUser;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

interface Note extends NoteSummary {
  web_url?: string;
  attendees?: GranolaUser[];
  calendar_event?: {
    event_title: string | null;
    invitees?: { email: string }[];
    scheduled_start_time: string | null;
    scheduled_end_time: string | null;
  } | null;
  summary_text?: string;
  summary_markdown?: string | null;
}

interface TranscriptItem {
  speaker: { source: "microphone" | "speaker"; attribution?: "me" | "them"; diarization_label?: string; name?: string };
  text: string;
  start_time: string;
  end_time: string;
}

function httpStatus(e: unknown): number | null {
  const m = /→ (\d{3}):/.exec((e as Error)?.message ?? "");
  return m ? Number(m[1]) : null;
}

function granolaClient(apiKey: string) {
  const base = serverEnv.granolaApiBase().replace(/\/+$/, "");
  let last = 0;

  async function get<T>(path: string, query: Record<string, string | number | null | undefined> = {}): Promise<T> {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return apiFetch<T>(url.toString(), { method: "GET", token: apiKey });
  }

  return {
    listNotes: (q: { updatedAfter?: string; cursor?: string | null; pageSize?: number }) =>
      get<{ notes: NoteSummary[]; hasMore: boolean; cursor: string | null }>("/notes", {
        updated_after: q.updatedAfter,
        cursor: q.cursor,
        page_size: q.pageSize ?? 30,
      }),
    getNote: (id: string) => get<Note>(`/notes/${encodeURIComponent(id)}`),
    async getTranscript(id: string): Promise<TranscriptItem[]> {
      const out: TranscriptItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const res: { transcript: TranscriptItem[]; hasMore: boolean; cursor: string | null } = await get(
          `/notes/${encodeURIComponent(id)}/transcript`,
          { cursor, page_size: 100 },
        );
        out.push(...(res.transcript ?? []));
        if (!res.hasMore || !res.cursor) break;
        cursor = res.cursor;
      }
      return out;
    },
  };
}

// ── Key validation + connect ────────────────────────────────────────────────

export type GranolaKeyCheck = { ok: true } | { ok: false; error: string };

/** Cheap read (one note summary) to prove the key works. */
export async function validateGranolaKey(apiKey: string): Promise<GranolaKeyCheck> {
  try {
    await granolaClient(apiKey).listNotes({ pageSize: 1 });
    return { ok: true };
  } catch (e) {
    const s = httpStatus(e);
    if (s === 401) return { ok: false, error: "Granola rejected this API key." };
    if (s === 403) return { ok: false, error: "This Granola key can't read notes. Check its access scope in Granola settings." };
    if (s === 429) return { ok: false, error: "Granola is rate limiting requests. Try again in a minute." };
    if (s === null) return { ok: false, error: "Could not reach Granola." };
    return { ok: false, error: `Granola returned an error (${s}).` };
  }
}

/**
 * Validate → save (encrypted key) → queue the first sync. Any workspace member
 * may connect. Granola has no "who am I" endpoint, and personal keys belong to
 * a member (their meetings feed that member's warm paths), so the connection
 * is keyed per member: external_account_id = `member:<user id>`.
 */
export async function connectGranola(
  db: SupabaseClient,
  p: { workspaceId: string; userId: string; userEmail: string | null; apiKey: string },
): Promise<{ ok: true; connectionId: string } | { ok: false; error: string }> {
  const check = await validateGranolaKey(p.apiKey);
  if (!check.ok) return check;
  const conn = await saveConnection(db, {
    workspaceId: p.workspaceId,
    provider: "granola",
    externalAccountId: `member:${p.userId}`,
    accountLabel: p.userEmail ?? "Granola",
    connectedBy: p.userId,
    secret: { api_key: p.apiKey },
  });
  await enqueue("granola.sync", { connectionId: conn.id }, { workspaceId: p.workspaceId, dedupeKey: `granola.sync:${conn.id}`, priority: 70 });
  return { ok: true, connectionId: conn.id };
}

// ── Sync (job "granola.sync") ───────────────────────────────────────────────

interface Prospect {
  contactId: string;
  accountId: string;
  fullName: string;
  title: string | null;
  companyId: string | null;
  companyName: string | null;
  companyDomain: string | null;
}

/** Workspace contacts that sit on an account, keyed by lowercased email. */
async function loadProspects(db: SupabaseClient, workspaceId: string): Promise<Map<string, Prospect>> {
  const out = new Map<string, Prospect>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("contacts")
      .select("id, full_name, title, email, account_id, company_id, companies(name, domain)")
      .eq("workspace_id", workspaceId)
      .not("account_id", "is", null)
      .not("email", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load contacts: ${error.message}`);
    for (const c of data ?? []) {
      const company = c.companies as unknown as { name: string | null; domain: string | null } | null;
      out.set(String(c.email).toLowerCase(), {
        contactId: c.id as string,
        accountId: c.account_id as string,
        fullName: c.full_name as string,
        title: (c.title as string | null) ?? null,
        companyId: (c.company_id as string | null) ?? null,
        companyName: company?.name ?? null,
        companyDomain: normalizeDomain(company?.domain),
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

function attendeesOf(note: Note): { name: string | null; email: string }[] {
  const seen = new Map<string, { name: string | null; email: string }>();
  for (const a of note.attendees ?? []) {
    const email = a.email?.trim().toLowerCase();
    if (email && !seen.has(email)) seen.set(email, { name: a.name ?? null, email });
  }
  for (const i of note.calendar_event?.invitees ?? []) {
    const email = i.email?.trim().toLowerCase();
    if (email && !seen.has(email)) seen.set(email, { name: null, email });
  }
  return [...seen.values()];
}

function formatTranscript(items: TranscriptItem[], ownerName: string | null): string {
  const label = (s: TranscriptItem["speaker"]) =>
    s.name ?? (s.attribution === "me" ? ownerName ?? "Me" : s.attribution === "them" ? "Them" : s.diarization_label ?? (s.source === "microphone" ? ownerName ?? "Me" : "Them"));
  const lines: { who: string; text: string }[] = [];
  for (const t of items) {
    const text = t.text?.trim();
    if (!text) continue;
    const who = label(t.speaker);
    const prev = lines[lines.length - 1];
    if (prev && prev.who === who) prev.text += ` ${text}`;
    else lines.push({ who, text });
  }
  return lines.map((l) => `${l.who}: ${l.text}`).join("\n");
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

async function recordNetwork(
  db: SupabaseClient,
  conn: ConnectionRow,
  matched: { name: string | null; email: string; prospect: Prospect }[],
  when: string | null,
) {
  if (!conn.connected_by) return;
  for (const m of matched) {
    const fullName = m.name || m.prospect.fullName || m.email;
    const key = identityKey({ email: m.email, full_name: fullName });
    const { data: existing, error } = await db
      .from("network_connections")
      .select("id, interactions, last_interaction_at, title, company_id")
      .eq("workspace_id", conn.workspace_id)
      .eq("member_id", conn.connected_by)
      .eq("source", "granola")
      .eq("identity_key", key)
      .maybeSingle();
    if (error) throw new Error(`load network connection: ${error.message}`);
    if (existing) {
      await db
        .from("network_connections")
        .update({
          interactions: (existing.interactions as number) + 1,
          last_interaction_at: later(existing.last_interaction_at as string | null, when),
          title: existing.title ?? m.prospect.title,
          company_id: existing.company_id ?? m.prospect.companyId,
        })
        .eq("id", existing.id);
      continue;
    }
    const { error: insErr } = await db.from("network_connections").insert({
      workspace_id: conn.workspace_id,
      member_id: conn.connected_by,
      full_name: fullName,
      email: m.email,
      title: m.prospect.title,
      company_name: m.prospect.companyName,
      company_domain: normalizeDomain(m.email.split("@")[1]) ?? m.prospect.companyDomain,
      company_id: m.prospect.companyId,
      source: "granola",
      interactions: 1,
      last_interaction_at: when,
      identity_key: key,
    });
    if (insErr && insErr.code !== "23505") throw new Error(`save network connection: ${insErr.message}`);
  }
}

type NoteResult = "deleted" | "unavailable" | "not_prospect" | "removed" | "updated" | "created";

async function processNote(
  db: SupabaseClient,
  conn: ConnectionRow,
  client: ReturnType<typeof granolaClient>,
  prospects: Map<string, Prospect>,
  summary: NoteSummary,
  touchedAccounts: Set<string>,
): Promise<NoteResult> {
  const { data: existing, error: exErr } = await db
    .from("meetings")
    .select("id")
    .eq("connection_id", conn.id)
    .eq("external_id", summary.id)
    .maybeSingle();
  if (exErr) throw new Error(`load meeting: ${exErr.message}`);

  if (summary.deleted_at) {
    if (existing) await db.from("meetings").delete().eq("id", existing.id);
    return "deleted";
  }

  let note: Note;
  try {
    note = await client.getNote(summary.id); // no transcript yet: attendees decide whether we read further
  } catch (e) {
    if (httpStatus(e) === 404) return "unavailable";
    throw e;
  }

  const attendees = attendeesOf(note);
  const matched = attendees
    .map((a) => ({ ...a, prospect: prospects.get(a.email) }))
    .filter((a): a is { name: string | null; email: string; prospect: Prospect } => !!a.prospect);
  if (matched.length === 0) {
    // No prospect attended (or the attendee list changed): keep no copy.
    if (existing) {
      await db.from("meetings").delete().eq("id", existing.id);
      return "removed";
    }
    return "not_prospect";
  }

  const transcript = formatTranscript(await client.getTranscript(summary.id), note.owner?.name ?? null);

  // The meeting belongs to the account with the most attendees present.
  const perAccount = new Map<string, typeof matched>();
  for (const m of matched) perAccount.set(m.prospect.accountId, [...(perAccount.get(m.prospect.accountId) ?? []), m]);
  const accountId = [...perAccount.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];

  const startedAt = note.calendar_event?.scheduled_start_time ?? note.created_at ?? null;
  const row = {
    workspace_id: conn.workspace_id,
    connection_id: conn.id,
    external_id: summary.id,
    title: note.title ?? note.calendar_event?.event_title ?? null,
    started_at: startedAt,
    ended_at: note.calendar_event?.scheduled_end_time ?? null,
    attendees,
    ai_notes: note.summary_markdown ?? note.summary_text ?? null,
    transcript: transcript || null,
    account_id: accountId,
  };

  if (existing) {
    const { error } = await db.from("meetings").update(row).eq("id", existing.id);
    if (error) throw new Error(`update meeting: ${error.message}`);
    return "updated";
  }
  const { data: inserted, error: insErr } = await db.from("meetings").insert(row).select("id").single();
  if (insErr) {
    if (insErr.code === "23505") {
      await db.from("meetings").update(row).eq("connection_id", conn.id).eq("external_id", summary.id);
      return "updated";
    }
    throw new Error(`save meeting: ${insErr.message}`);
  }

  // New meeting: timeline entry per account present, and the member now knows these people.
  const title = row.title ?? "Meeting";
  const activities = [...perAccount.entries()].map(([acc, ms]) => ({
    workspace_id: conn.workspace_id,
    account_id: acc,
    contact_id: ms[0].prospect.contactId,
    actor_id: conn.connected_by,
    kind: "meeting",
    title: `Meeting: ${title}`,
    body: (note.summary_text ?? "").slice(0, 600) || null,
    data: {
      source: "granola",
      meeting_id: inserted.id,
      external_id: summary.id,
      web_url: note.web_url ?? null,
      attendees: ms.map((m) => ({ name: m.name ?? m.prospect.fullName, email: m.email, contact_id: m.prospect.contactId })),
    },
    occurred_at: startedAt ?? new Date().toISOString(),
  }));
  const { error: actErr } = await db.from("activities").insert(activities);
  if (actErr) throw new Error(`record meeting activity: ${actErr.message}`);

  await recordNetwork(db, conn, matched, startedAt);
  for (const acc of perAccount.keys()) touchedAccounts.add(acc);
  return "created";
}

export async function syncGranola(db: SupabaseClient, connectionId: string) {
  const started = Date.now();
  let conn: ConnectionRow;
  try {
    conn = await getConnection(db, connectionId);
  } catch {
    return { skipped: "connection not found" }; // disconnected since the job was queued
  }
  if (conn.provider !== "granola" || conn.status === "disconnected") return { skipped: "not an active Granola connection" };
  const apiKey = (await getSecret(db, conn.id)).api_key;
  if (!apiKey) throw new Error("Granola API key missing. Reconnect Granola.");
  const client = granolaClient(apiKey);

  const since =
    typeof conn.sync_cursor?.updated_after === "string" && !Number.isNaN(Date.parse(conn.sync_cursor.updated_after))
      ? conn.sync_cursor.updated_after
      : new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
  // UNVERIFIED: whether `updated_after` is exclusive; step back 1 s and rely on
  // idempotent upserts so a note on the boundary is never skipped.
  const queryFrom = new Date(Date.parse(since) - 1000).toISOString();

  const summaries: NoteSummary[] = [];
  let truncated = false;
  try {
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      const res = await client.listNotes({ updatedAfter: queryFrom, cursor });
      summaries.push(...(res.notes ?? []));
      if (!res.hasMore || !res.cursor) break;
      if (page + 1 >= MAX_LIST_PAGES) {
        // UNVERIFIED: list order is undocumented, so with more than
        // MAX_LIST_PAGES×30 changed notes in one window some may be missed.
        truncated = true;
        break;
      }
      cursor = res.cursor;
    }
  } catch (e) {
    if (httpStatus(e) === 401) await markError(db, conn.id, "Granola rejected the stored API key. Reconnect Granola.");
    throw e;
  }
  // List order isn't documented: process oldest-updated first so the cursor
  // can advance safely when a run stops early.
  summaries.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));

  const prospects = await loadProspects(db, conn.workspace_id);
  const counts: Record<NoteResult, number> = { deleted: 0, unavailable: 0, not_prospect: 0, removed: 0, updated: 0, created: 0 };
  const touchedAccounts = new Set<string>();
  let cursorOut = since;
  let more = false;

  for (const s of summaries) {
    if (Date.now() - started > SYNC_BUDGET_MS) {
      more = true;
      break;
    }
    try {
      counts[await processNote(db, conn, client, prospects, s, touchedAccounts)]++;
    } catch (e) {
      if (httpStatus(e) === 401) await markError(db, conn.id, "Granola rejected the stored API key. Reconnect Granola.");
      // Persist progress so far before failing the job.
      if (cursorOut !== since) await markSynced(db, conn.id, { updated_after: cursorOut });
      throw e;
    }
    cursorOut = later(cursorOut, s.updated_at) ?? cursorOut;
  }
  if (truncated) more = true;

  await markSynced(db, conn.id, { updated_after: cursorOut });

  for (const accountId of touchedAccounts) {
    await enqueue("account.warm_paths", { accountId }, { workspaceId: conn.workspace_id, dedupeKey: `account.warm_paths:${accountId}`, priority: 90 }).catch(() => null);
  }
  if (more) {
    await enqueue("granola.sync", { connectionId: conn.id }, {
      workspaceId: conn.workspace_id,
      dedupeKey: `granola.sync:${conn.id}:more`,
      runAfter: new Date(Date.now() + 30_000),
      priority: 70,
    });
  }
  return { listed: summaries.length, ...counts, more, truncated };
}
