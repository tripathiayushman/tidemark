import type { SupabaseClient } from "@supabase/supabase-js";
import { signToken } from "@/lib/crypto";
import { publicEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import type { Provider } from "@/lib/types";
import { markSynced, saveConnection, type ConnectionRow } from "./connections";
import { handleInstantlyWebhook } from "./outreach/instantly";

// DEV-ONLY integration sandbox. Lets you click through connect → sync →
// campaign → reply flows without real HubSpot / Attio / Gmail / Instantly /
// Granola accounts. Sandbox connections are labelled "(sandbox)", carry
// settings.sandbox=true, and are routed here by the job handlers instead of
// to the real provider code. Nothing leaves the machine:
//   * CRM push/pull writes crm_links with fake remote ids
//   * Gmail "sends" campaign messages (template drafts, no LLM quota),
//     compresses follow-up delays from days to minutes, and simulates replies
//   * Instantly marks leads added; reply/bounce/unsubscribe simulations go
//     through the REAL webhook handler
//   * Granola creates fake meetings with prospects (→ warm paths)
// Never available in production builds.

export function sandboxEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.INTEGRATIONS_SANDBOX === "true";
}

export function isSandbox(conn: { settings?: Record<string, unknown> | null } | null | undefined): boolean {
  return Boolean(conn?.settings && (conn.settings as { sandbox?: boolean }).sandbox === true);
}

const NAMES: Record<Provider, string> = { hubspot: "HubSpot", attio: "Attio", gmail: "Gmail", instantly: "Instantly", granola: "Granola" };
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const SANDBOX_INSTANTLY_CAMPAIGNS = [
  { id: "sbx-camp-expansion", name: "Sandbox · Expansion plays", status: "active" },
  { id: "sbx-camp-newline", name: "Sandbox · New line follow-up", status: "active" },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export async function connectSandbox(db: SupabaseClient, workspaceId: string, userId: string, provider: Provider) {
  if (!sandboxEnabled()) throw new Error("Sandbox is not enabled");
  const perMember = provider === "gmail" || provider === "granola";
  return saveConnection(db, {
    workspaceId,
    provider,
    externalAccountId: perMember ? `sandbox:${userId}` : "sandbox",
    accountLabel: provider === "gmail" ? "you@sandbox.example (sandbox)" : `${NAMES[provider]} (sandbox)`,
    scopes: provider === "gmail" ? ["openid", "email", READ_SCOPE, SEND_SCOPE] : [],
    settings: { sandbox: true, ...(provider === "gmail" ? { sending_enabled: false, prospect_scope: "qualified" } : {}) },
    connectedBy: userId,
    secret: { sandbox: true },
  });
}

// ── CRM ──────────────────────────────────────────────────────────────────
export async function sandboxCrmPush(db: SupabaseClient, conn: ConnectionRow, accountIds?: string[]) {
  let q = db.from("accounts").select("id, company_id, companies(name)").eq("workspace_id", conn.workspace_id).eq("research_status", "qualified");
  if (accountIds?.length) q = q.in("id", accountIds);
  const { data: accounts } = await q.limit(500);
  let companies = 0, people = 0;
  const now = new Date().toISOString();
  for (const a of accounts ?? []) {
    const { data: existing } = await db.from("crm_links").select("id").eq("connection_id", conn.id).eq("object_type", "company").eq("local_id", a.id).maybeSingle();
    await db.from("crm_links").upsert(
      { workspace_id: conn.workspace_id, connection_id: conn.id, object_type: "company", local_id: a.id, remote_id: `sbx-co-${a.id.slice(0, 8)}`, last_pushed_at: now },
      { onConflict: "connection_id,object_type,local_id" },
    );
    if (!existing) {
      companies++;
      await db.from("activities").insert({ workspace_id: conn.workspace_id, account_id: a.id, kind: "crm_push", title: `Pushed to ${NAMES[conn.provider]} (sandbox)` });
    }
    const { data: contacts } = await db.from("contacts").select("id").eq("account_id", a.id).not("email", "is", null);
    for (const c of contacts ?? []) {
      await db.from("crm_links").upsert(
        { workspace_id: conn.workspace_id, connection_id: conn.id, object_type: "person", local_id: c.id, remote_id: `sbx-p-${c.id.slice(0, 8)}`, last_pushed_at: now },
        { onConflict: "connection_id,object_type,local_id" },
      );
      people++;
    }
  }
  await markSynced(db, conn.id, { ...(conn.sync_cursor ?? {}), last_push_at: now, sandbox: true });
  return { sandbox: true, companies, people };
}

export async function sandboxCrmPull(db: SupabaseClient, conn: ConnectionRow) {
  const now = new Date().toISOString();
  const { count } = await db.from("crm_links").update({ last_pulled_at: now }, { count: "exact" }).eq("connection_id", conn.id).eq("object_type", "person");
  await sandboxCrmPush(db, conn); // incremental push, like the real sync
  return { sandbox: true, pulled: count ?? 0 };
}

// ── Gmail ────────────────────────────────────────────────────────────────
async function recordReply(db: SupabaseClient, conn: ConnectionRow, e: { id: string; contact_id: string; account_id: string | null; gmail_thread_id: string | null }) {
  const { data: contact } = await db.from("contacts").select("full_name, email").eq("id", e.contact_id).single();
  const thread = e.gmail_thread_id ?? `sbx-thread-${e.id.slice(0, 8)}`;
  await db.from("email_messages").upsert(
    {
      workspace_id: conn.workspace_id, connection_id: conn.id, gmail_message_id: `sbx-reply-${e.id.slice(0, 8)}`, gmail_thread_id: thread,
      account_id: e.account_id, contact_id: e.contact_id, direction: "inbound", from_email: contact?.email ?? null,
      subject: "Re: (sandbox reply)", snippet: "Thanks for reaching out — the timing is good. Can you send over some details? (sandbox)", sent_at: new Date().toISOString(),
    },
    { onConflict: "connection_id,gmail_message_id", ignoreDuplicates: true },
  );
  await db.from("campaign_enrollments").update({ status: "stopped_reply", stopped_at: new Date().toISOString(), stop_reason: "Replied (sandbox)", next_send_at: null }).eq("id", e.id).in("status", ["active", "completed"]);
  await db.from("tasks").insert({ workspace_id: conn.workspace_id, account_id: e.account_id, contact_id: e.contact_id, title: `Reply from ${contact?.full_name ?? "prospect"} (sandbox)`, kind: "follow_up", source: "system", due_on: new Date().toISOString().slice(0, 10) });
  await db.from("activities").insert({ workspace_id: conn.workspace_id, account_id: e.account_id, contact_id: e.contact_id, kind: "reply", title: `Reply from ${contact?.full_name ?? "prospect"} (sandbox)` });
}

export async function sandboxGmailSync(db: SupabaseClient, conn: ConnectionRow) {
  // deterministic: roughly 1 in 3 enrollments that have received an email "reply"
  const { data: enrollments } = await db
    .from("campaign_enrollments")
    .select("id, contact_id, account_id, gmail_thread_id, current_step, campaigns!inner(mailbox_connection_id)")
    .eq("campaigns.mailbox_connection_id", conn.id)
    .in("status", ["active", "completed"]) // people reply after the last step too
    .gt("current_step", 0);
  let replies = 0;
  for (const e of enrollments ?? []) {
    if (hash(e.id) % 3 !== 0) continue;
    await recordReply(db, conn, e as unknown as { id: string; contact_id: string; account_id: string | null; gmail_thread_id: string | null });
    replies++;
  }
  // a few correspondents at prospect companies → warm paths
  const network = await sandboxNetwork(db, conn, "gmail");
  await markSynced(db, conn.id, { sandbox: true, last_sync: new Date().toISOString() });
  return { sandbox: true, replies, network };
}

export async function simulateGmailReply(db: SupabaseClient, conn: ConnectionRow) {
  const { data } = await db
    .from("campaign_enrollments")
    .select("id, contact_id, account_id, gmail_thread_id, campaigns!inner(mailbox_connection_id)")
    .eq("campaigns.mailbox_connection_id", conn.id)
    .in("status", ["active", "completed"])
    .gt("current_step", 0)
    .limit(1);
  const e = data?.[0];
  if (!e) return { error: "No active enrollment has been emailed yet — launch a sandbox campaign first." };
  await recordReply(db, conn, e as unknown as { id: string; contact_id: string; account_id: string | null; gmail_thread_id: string | null });
  return { ok: true };
}

/** Template draft — no LLM call, so sandbox testing doesn't spend model quota. */
async function templateDraft(db: SupabaseClient, enrollment: { account_id: string | null; contact_id: string }, step: number) {
  const [{ data: acc }, { data: contact }] = await Promise.all([
    enrollment.account_id ? db.from("accounts").select("reason_to_buy, why, companies(name)").eq("id", enrollment.account_id).single() : Promise.resolve({ data: null }),
    db.from("contacts").select("first_name, full_name").eq("id", enrollment.contact_id).single(),
  ]);
  const company = (acc?.companies as unknown as { name: string } | null)?.name ?? "your team";
  const first = contact?.first_name ?? contact?.full_name?.split(" ")[0] ?? "there";
  if (step === 0) {
    return {
      subject: `${company}: ${(acc?.reason_to_buy ?? "your expansion").toLowerCase()}`.slice(0, 80),
      body: `Hi ${first},\n\nI noticed ${acc?.why ?? "some recent changes at your plant"}\n\nWould it be useful to compare notes on timing for the next phase?\n\n(Sandbox draft — not sent anywhere.)`,
    };
  }
  return { subject: "", body: `Hi ${first}, following up on my note about ${company}. Happy to send a short summary instead of a call.\n\n(Sandbox follow-up.)` };
}

export async function sandboxDraft(db: SupabaseClient, enrollmentId: string) {
  const { data: e } = await db.from("campaign_enrollments").select("id, workspace_id, account_id, contact_id, current_step, campaign_id").eq("id", enrollmentId).single();
  if (!e) return { skipped: "enrollment not found" };
  const draft = await templateDraft(db, e, e.current_step);
  await db.from("campaign_messages").upsert(
    { workspace_id: e.workspace_id, enrollment_id: e.id, step_position: e.current_step, subject: draft.subject, body: draft.body, status: "draft" },
    { onConflict: "enrollment_id,step_position", ignoreDuplicates: true },
  );
  return { sandbox: true, drafted: 1 };
}

/** Campaign "sending" for sandbox mailboxes: respects the 40/day cap; follow-up delays become minutes. */
export async function sandboxSendDue(db: SupabaseClient) {
  const { data: mailboxes } = await db.from("integration_connections").select("*").eq("provider", "gmail").eq("status", "active");
  let sent = 0;
  for (const mb of (mailboxes ?? []) as ConnectionRow[]) {
    if (!isSandbox(mb) || mb.settings?.sending_enabled !== true) continue;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const { count: today } = await db.from("campaign_messages").select("id", { count: "exact", head: true }).eq("mailbox_connection_id", mb.id).eq("status", "sent").gte("sent_at", dayStart.toISOString());
    let remaining = Math.max(0, 40 - (today ?? 0));
    const { data: due } = await db
      .from("campaign_enrollments")
      .select("id, workspace_id, account_id, contact_id, current_step, gmail_thread_id, campaign_id, campaigns!inner(id, status, channel, mailbox_connection_id, campaign_steps(position, delay_days))")
      .eq("campaigns.mailbox_connection_id", mb.id)
      .eq("campaigns.status", "active")
      .eq("status", "active")
      .lte("next_send_at", new Date().toISOString())
      .limit(remaining);
    for (const e of due ?? []) {
      if (remaining <= 0) break;
      const steps = ((e.campaigns as unknown as { campaign_steps: { position: number; delay_days: number }[] }).campaign_steps ?? []).sort((a, b) => a.position - b.position);
      if (e.current_step >= steps.length) {
        await db.from("campaign_enrollments").update({ status: "completed", next_send_at: null }).eq("id", e.id);
        continue;
      }
      const { data: existing } = await db.from("campaign_messages").select("id, subject, body, status").eq("enrollment_id", e.id).eq("step_position", e.current_step).maybeSingle();
      if (existing?.status === "skipped") {
        await db.from("campaign_enrollments").update({ current_step: e.current_step + 1 }).eq("id", e.id);
        continue;
      }
      const draft = existing ?? (await templateDraft(db, e, e.current_step));
      const { data: contact } = await db.from("contacts").select("email").eq("id", e.contact_id).single();
      const token = signToken({ ws: e.workspace_id, email: contact?.email ?? "" });
      const body = `${draft.body}\n\n—\nUnsubscribe: ${publicEnv.appUrl()}/u/${token}`;
      const thread = e.gmail_thread_id ?? `sbx-thread-${e.id.slice(0, 8)}`;
      await db.from("campaign_messages").upsert(
        { workspace_id: e.workspace_id, enrollment_id: e.id, step_position: e.current_step, subject: draft.subject, body, status: "sent", sent_at: new Date().toISOString(), mailbox_connection_id: mb.id, gmail_message_id: `sbx-msg-${e.id.slice(0, 6)}-${e.current_step}`, gmail_thread_id: thread },
        { onConflict: "enrollment_id,step_position" },
      );
      const next = steps[e.current_step + 1];
      await db.from("campaign_enrollments").update({
        current_step: e.current_step + 1,
        gmail_thread_id: thread,
        status: next ? "active" : "completed",
        next_send_at: next ? new Date(Date.now() + Math.max(1, next.delay_days) * 60_000).toISOString() : null, // sandbox: days → minutes
      }).eq("id", e.id);
      await db.from("activities").insert({ workspace_id: e.workspace_id, account_id: e.account_id, contact_id: e.contact_id, kind: "email_sent", title: `Email ${e.current_step === 0 ? "sent" : `follow-up ${e.current_step} sent`} (sandbox)` });
      sent++;
      remaining--;
    }
  }
  return { sandbox: true, sent };
}

// ── Instantly ────────────────────────────────────────────────────────────
export async function sandboxInstantlyPush(db: SupabaseClient, campaignId: string, enrollmentIds: string[]) {
  let added = 0;
  for (const id of enrollmentIds) {
    const { data: e } = await db.from("campaign_enrollments").select("id, workspace_id, account_id, contact_id, external_lead_id").eq("id", id).single();
    if (!e || e.external_lead_id) continue;
    await sandboxDraft(db, id);
    await db.from("campaign_enrollments").update({ external_lead_id: `sbx-lead-${id.slice(0, 8)}` }).eq("id", id);
    await db.from("activities").insert({ workspace_id: e.workspace_id, account_id: e.account_id, contact_id: e.contact_id, kind: "campaign_enrolled", title: "Added to Instantly campaign (sandbox)" });
    added++;
  }
  return { sandbox: true, campaignId, added };
}

export async function simulateInstantlyEvent(db: SupabaseClient, conn: ConnectionRow, kind: "reply" | "bounce" | "unsubscribe") {
  const { data } = await db
    .from("campaign_enrollments")
    .select("id, external_lead_id, contacts(email), campaigns!inner(instantly_connection_id, instantly_campaign_id)")
    .eq("campaigns.instantly_connection_id", conn.id)
    .eq("status", "active")
    .not("external_lead_id", "is", null)
    .limit(1);
  const e = data?.[0] as unknown as { id: string; external_lead_id: string; contacts: { email: string } | null; campaigns: { instantly_campaign_id: string } } | undefined;
  if (!e) return { error: "No active Instantly enrollment — enroll prospects in a sandbox Instantly campaign and launch it first." };
  const eventType = kind === "reply" ? "reply_received" : kind === "bounce" ? "email_bounced" : "lead_unsubscribed";
  // Goes through the real webhook handler.
  const result = await handleInstantlyWebhook(db, conn.id, {
    event_type: eventType,
    lead_email: e.contacts?.email,
    campaign_id: e.campaigns.instantly_campaign_id,
    lead_id: e.external_lead_id,
    timestamp: new Date().toISOString(),
    reply_text_snippet: kind === "reply" ? "Sounds interesting — send me more info. (sandbox)" : undefined,
  });
  return { ok: true, result };
}

// ── Granola ──────────────────────────────────────────────────────────────
async function sandboxNetwork(db: SupabaseClient, conn: ConnectionRow, source: "gmail" | "granola") {
  if (!conn.connected_by) return 0;
  const { data: accts } = await db.from("accounts").select("id, company_id").eq("workspace_id", conn.workspace_id).eq("research_status", "qualified").limit(20);
  let added = 0;
  const picked = (accts ?? []).filter((x) => hash(x.id + source) % 4 === 0);
  for (const a of (picked.length ? picked : (accts ?? []).slice(0, 1)).slice(0, 3)) {
    const { data: c } = await db.from("contacts").select("id, full_name, email, title").eq("account_id", a.id).limit(1).maybeSingle();
    if (!c?.email) continue;
    const { error } = await db.from("network_connections").upsert(
      { workspace_id: conn.workspace_id, member_id: conn.connected_by, full_name: c.full_name, email: c.email, title: c.title, company_id: a.company_id, company_domain: c.email.split("@")[1], source, interactions: 3, identity_key: c.email.toLowerCase(), last_interaction_at: new Date().toISOString() },
      { onConflict: "workspace_id,member_id,source,identity_key", ignoreDuplicates: true },
    );
    if (!error) {
      added++;
      await enqueue("account.warm_paths", { accountId: a.id }, { workspaceId: conn.workspace_id, dedupeKey: `warm:${a.id}`, priority: 60 });
    }
  }
  return added;
}

export async function sandboxGranolaSync(db: SupabaseClient, conn: ConnectionRow) {
  const { data: accts } = await db.from("accounts").select("id, companies(name)").eq("workspace_id", conn.workspace_id).eq("research_status", "qualified").limit(20);
  let meetings = 0;
  for (const a of (accts ?? []).filter((x) => hash(x.id) % 5 === 0).slice(0, 2)) {
    const { data: c } = await db.from("contacts").select("full_name, email").eq("account_id", a.id).limit(1).maybeSingle();
    if (!c) continue;
    const name = (a.companies as unknown as { name: string } | null)?.name ?? "prospect";
    const { error } = await db.from("meetings").upsert(
      {
        workspace_id: conn.workspace_id, connection_id: conn.id, external_id: `sbx-meet-${a.id.slice(0, 8)}`, title: `Intro call — ${name} (sandbox)`,
        started_at: new Date(Date.now() - 86_400_000).toISOString(), attendees: [{ name: c.full_name, email: c.email }],
        ai_notes: `Discussed their expansion timeline and what they need for commissioning. Next step: send a proposal. (sandbox)`, account_id: a.id,
      },
      { onConflict: "connection_id,external_id", ignoreDuplicates: true },
    );
    if (!error) {
      meetings++;
      await db.from("activities").insert({ workspace_id: conn.workspace_id, account_id: a.id, kind: "meeting", title: `Meeting with ${c.full_name} (sandbox)` });
    }
  }
  const network = await sandboxNetwork(db, conn, "granola");
  await markSynced(db, conn.id, { sandbox: true, last_sync: new Date().toISOString() });
  return { sandbox: true, meetings, network };
}
