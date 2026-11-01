import type { SupabaseClient } from "@supabase/supabase-js";
import { signToken } from "@/lib/crypto";
import { publicEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { getConnection, markError, type ConnectionRow } from "@/lib/integrations/connections";
import { draftEmail } from "@/lib/outreach/draft";
import {
  GMAIL_SEND_SCOPE,
  GmailSendError,
  buildMimeMessage,
  encodeBase64Url,
  getMessage,
  getThreadMetadata,
  gmailAccessToken,
  headerValue,
  isAutoReply,
  isBounceMessage,
  isSystemSender,
  parseAddressList,
  sendRawMessage,
  type GmailMessage,
} from "./client";
import {
  isValidTimeZone,
  isWithinWindow,
  nextAllowedTime,
  nextDayWindowStart,
  nextStepSendTime,
  remainingQuota,
  startOfLocalDay,
  type SendWindow,
} from "./schedule";

// Gmail campaign sender.
//
//   campaign.send_due  every 5 min: due enrollments of active gmail campaigns,
//                      grouped by mailbox, sent ONE AT A TIME (round-robin
//                      across mailboxes) inside the campaign window and under
//                      40/day/mailbox + campaign.daily_cap.
//   campaign.draft     pre-creates the next step's message as 'draft' so the
//                      team can review/edit it before it goes out.
//
// Guarantees: nothing sends unless settings.sending_enabled === true AND the
// gmail.send scope was granted; suppressed / unsubscribed / invalid contacts
// are never emailed; demo (.example) contacts are marked 'skipped'; every
// email carries an unsubscribe link plus RFC 8058 one-click headers; a send
// is never retried when its outcome is unknown (no duplicate emails).

const SEND_BUDGET_MS = 40_000; // stay inside one worker tick
const MAX_DUE_PER_RUN = 500;
const STALE_SENDING_MS = 5 * 60_000;
const COMPOSE_RETRY_MS = 60 * 60_000;
const SENT_STATUSES = ["sent", "bounced"];

type EnrollmentStatus = "active" | "completed" | "stopped_reply" | "stopped_bounce" | "stopped_unsubscribe" | "stopped_manual" | "failed";

interface CampaignRow {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  channel: string;
  mailbox_connection_id: string | null;
  sending_days: number[];
  send_window_start: string;
  send_window_end: string;
  timezone: string;
  daily_cap: number;
}

interface EnrollmentRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  contact_id: string;
  account_id: string | null;
  status: EnrollmentStatus;
  current_step: number;
  next_send_at: string | null;
  gmail_thread_id: string | null;
  campaigns: CampaignRow;
}

interface StepRow {
  position: number;
  delay_days: number;
  subject_template: string | null;
  body_template: string | null;
  ai_draft: boolean;
}

interface ContactRow {
  id: string;
  workspace_id: string;
  email: string | null;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email_status: string;
  unsubscribed_at: string | null;
  account_id: string | null;
  companies: { name: string } | null;
  accounts: { companies: { name: string } | null } | null;
}

interface MessageRow {
  id: string;
  step_position: number;
  subject: string | null;
  body: string;
  status: string;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  sent_at: string | null;
  updated_at: string;
}

const ENROLLMENT_SELECT =
  "id, workspace_id, campaign_id, contact_id, account_id, status, current_step, next_send_at, gmail_thread_id, " +
  "campaigns!inner(id, workspace_id, name, status, channel, mailbox_connection_id, sending_days, send_window_start, send_window_end, timezone, daily_cap)";
const CONTACT_SELECT =
  "id, workspace_id, email, full_name, first_name, last_name, title, email_status, unsubscribed_at, account_id, companies(name), accounts(companies(name))";
const MESSAGE_SELECT = "id, step_position, subject, body, status, gmail_message_id, gmail_thread_id, sent_at, updated_at";

// ── Shared helpers (also used by sync + unsubscribe) ───────────────────────

/** Sending is allowed only when the member switched it on AND granted gmail.send. */
export function canSendFrom(conn: ConnectionRow): boolean {
  return (
    conn.provider === "gmail" &&
    conn.status === "active" &&
    conn.settings?.sandbox !== true && // sandbox mailboxes are "sent" by integrations/sandbox.ts

    conn.settings?.sending_enabled === true &&
    (conn.scopes ?? []).includes(GMAIL_SEND_SCOPE)
  );
}

export function unsubscribeToken(workspaceId: string, email: string): string {
  return signToken({ ws: workspaceId, email: email.trim().toLowerCase() });
}

export function unsubscribeUrls(workspaceId: string, email: string): { page: string; oneClick: string } {
  const token = unsubscribeToken(workspaceId, email);
  const base = publicEnv.appUrl().replace(/\/+$/, "");
  return { page: `${base}/u/${token}`, oneClick: `${base}/api/unsubscribe?token=${encodeURIComponent(token)}` };
}

/** Stops enrollments (only those currently in `from`) and skips their unsent drafts. */
export async function stopEnrollments(
  db: SupabaseClient,
  enrollmentIds: string[],
  status: EnrollmentStatus,
  reason: string,
  from: EnrollmentStatus[] = ["active"],
): Promise<string[]> {
  if (enrollmentIds.length === 0) return [];
  const { data, error } = await db
    .from("campaign_enrollments")
    .update({ status, stopped_at: new Date().toISOString(), stop_reason: reason, next_send_at: null })
    .in("id", enrollmentIds)
    .in("status", from)
    .select("id");
  if (error) throw new Error(`stop enrollments: ${error.message}`);
  const stopped = (data ?? []).map((r) => r.id as string);
  if (stopped.length) {
    await db
      .from("campaign_messages")
      .update({ status: "skipped", error: reason })
      .in("enrollment_id", stopped)
      .in("status", ["draft", "scheduled"]);
  }
  return stopped;
}

/** An enrollment's campaign thread, as seen by sync / the pre-send reply check. */
export interface ThreadEnrollment {
  enrollmentId: string;
  campaignId: string;
  campaignName: string;
  contactId: string;
  accountId: string | null;
  contactEmail: string;
  contactName: string;
}

/** Bounce on a campaign thread: last sent message 'bounced', enrollment stopped, address suppressed. */
export async function recordBounce(
  db: SupabaseClient,
  conn: ConnectionRow,
  t: ThreadEnrollment,
  opts: { emailMessageId?: string | null } = {},
): Promise<boolean> {
  const { data: last } = await db
    .from("campaign_messages")
    .select("id")
    .eq("enrollment_id", t.enrollmentId)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last) await db.from("campaign_messages").update({ status: "bounced", error: "bounced" }).eq("id", last.id);
  const stopped = await stopEnrollments(db, [t.enrollmentId], "stopped_bounce", "bounce", ["active", "completed"]);
  await db
    .from("suppressions")
    .upsert({ workspace_id: conn.workspace_id, email: t.contactEmail, reason: "bounce", source: "gmail" }, { onConflict: "workspace_id,email", ignoreDuplicates: true });
  const changed = Boolean(stopped.length || last);
  if (changed) {
    await db.from("activities").insert({
      workspace_id: conn.workspace_id,
      account_id: t.accountId,
      contact_id: t.contactId,
      kind: "email_bounced",
      title: `Email to ${t.contactName} bounced`,
      data: { campaign_id: t.campaignId, enrollment_id: t.enrollmentId, email_message_id: opts.emailMessageId ?? null },
    });
  }
  return changed;
}

/** Human reply on a campaign thread: stop the sequence, create a follow-up task + 'reply' activity (once). */
export async function recordReply(
  db: SupabaseClient,
  conn: ConnectionRow,
  t: ThreadEnrollment,
  from: { name: string | null; email: string },
  opts: { emailMessageId?: string | null; at?: string | null } = {},
): Promise<boolean> {
  const stopped = await stopEnrollments(db, [t.enrollmentId], "stopped_reply", "reply", ["active", "completed"]);
  if (!stopped.length) return false; // already stopped (earlier reply, bounce, unsubscribe, manual)
  const name = from.email === t.contactEmail ? t.contactName : from.name ?? from.email;
  // No email content here: tasks/activities outlive a Gmail disconnect, synced mail must not.
  const { error: taskError } = await db.from("tasks").insert({
    workspace_id: conn.workspace_id,
    account_id: t.accountId,
    contact_id: t.contactId,
    assignee_id: conn.connected_by,
    title: `Reply from ${name}`,
    description: `Replied to "${t.campaignName}". The sequence was stopped.`,
    kind: "follow_up",
    source: "system",
    due_on: new Date().toISOString().slice(0, 10),
  });
  if (taskError && taskError.code !== "23505") console.error(`[gmail] reply task: ${taskError.message}`);
  await db.from("activities").insert({
    workspace_id: conn.workspace_id,
    account_id: t.accountId,
    contact_id: t.contactId,
    kind: "reply",
    title: `Reply from ${name}`,
    data: { campaign_id: t.campaignId, enrollment_id: t.enrollmentId, email_message_id: opts.emailMessageId ?? null, source: "gmail" },
    occurred_at: opts.at ?? new Date().toISOString(),
  });
  return true;
}

export function renderTemplate(template: string | null | undefined, vars: Record<string, string>): string {
  return (template ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => vars[key.toLowerCase()] ?? "");
}

function templateVars(contact: ContactRow): Record<string, string> {
  const first = contact.first_name?.trim() || contact.full_name.trim().split(/\s+/)[0] || "there";
  return {
    first_name: first,
    last_name: contact.last_name ?? "",
    full_name: contact.full_name,
    title: contact.title ?? "",
    company: contact.companies?.name ?? contact.accounts?.companies?.name ?? "your company",
  };
}

type Block = { kind: "demo" } | { kind: "stop"; status: EnrollmentStatus; reason: string };

/** Why this contact must not be emailed (null = OK to email). */
async function blockFor(db: SupabaseClient, workspaceId: string, contact: ContactRow): Promise<Block | null> {
  const email = contact.email?.trim().toLowerCase();
  if (!email) return { kind: "stop", status: "failed", reason: "no email address" };
  if (contact.unsubscribed_at) return { kind: "stop", status: "stopped_unsubscribe", reason: "unsubscribed" };
  if (contact.email_status === "invalid") return { kind: "stop", status: "failed", reason: "invalid email" };
  const { data: sup, error } = await db.from("suppressions").select("reason").eq("workspace_id", workspaceId).eq("email", email).maybeSingle();
  if (error) throw new Error(`suppression check: ${error.message}`);
  if (sup) {
    const status: EnrollmentStatus = sup.reason === "bounce" ? "stopped_bounce" : sup.reason === "manual" ? "stopped_manual" : "stopped_unsubscribe";
    return { kind: "stop", status, reason: `suppressed (${sup.reason})` };
  }
  if (email.endsWith(".example")) return { kind: "demo" };
  return null;
}

function windowOf(c: CampaignRow): SendWindow {
  return { timezone: c.timezone, start: c.send_window_start, end: c.send_window_end, days: c.sending_days ?? [] };
}

async function loadSteps(db: SupabaseClient, campaignId: string): Promise<StepRow[]> {
  const { data, error } = await db
    .from("campaign_steps")
    .select("position, delay_days, subject_template, body_template, ai_draft")
    .eq("campaign_id", campaignId)
    .order("position", { ascending: true });
  if (error) throw new Error(`load steps: ${error.message}`);
  return (data ?? []) as unknown as StepRow[];
}

async function loadContact(db: SupabaseClient, contactId: string): Promise<ContactRow | null> {
  const { data } = await db.from("contacts").select(CONTACT_SELECT).eq("id", contactId).maybeSingle();
  return (data as unknown as ContactRow | null) ?? null;
}

async function loadMessage(db: SupabaseClient, enrollmentId: string, position: number): Promise<MessageRow | null> {
  const { data } = await db.from("campaign_messages").select(MESSAGE_SELECT).eq("enrollment_id", enrollmentId).eq("step_position", position).maybeSingle();
  return (data as unknown as MessageRow | null) ?? null;
}

async function sentMessages(db: SupabaseClient, enrollmentId: string, beforePosition: number): Promise<MessageRow[]> {
  const { data } = await db
    .from("campaign_messages")
    .select(MESSAGE_SELECT)
    .eq("enrollment_id", enrollmentId)
    .in("status", SENT_STATUSES)
    .lt("step_position", beforePosition)
    .order("step_position", { ascending: true });
  return (data ?? []) as unknown as MessageRow[];
}

function stripRe(subject: string): string {
  return subject.replace(/^\s*((re|fwd?)\s*:\s*)+/i, "").trim();
}

/** Subject + body for a step: AI draft when step.ai_draft, else templates with {{first_name}}/{{company}}. */
async function composeStep(db: SupabaseClient, e: EnrollmentRow, step: StepRow, contact: ContactRow): Promise<{ subject: string; body: string }> {
  const vars = templateVars(contact);
  if (step.ai_draft) {
    const accountId = e.account_id ?? contact.account_id;
    if (!accountId) throw new Error("No account to draft from");
    const previous = (await sentMessages(db, e.id, step.position)).map((m) => ({ subject: m.subject, body: m.body }));
    const d = await draftEmail(db, { accountId, contactId: contact.id, stepPosition: step.position, guidance: step.body_template, previous });
    return { subject: d.subject.trim() || renderTemplate(step.subject_template, vars).trim(), body: d.body };
  }
  const body = renderTemplate(step.body_template, vars);
  if (!body.trim()) throw new Error(`Step ${step.position} has no body`);
  return { subject: renderTemplate(step.subject_template, vars).trim(), body };
}

/** "Re: <first subject>" for follow-ups in an existing thread. */
async function threadSubject(db: SupabaseClient, e: EnrollmentRow, position: number, fallback: string | null): Promise<string> {
  const prior = await sentMessages(db, e.id, position);
  const base = stripRe(prior.find((m) => m.gmail_thread_id === e.gmail_thread_id)?.subject ?? prior[0]?.subject ?? fallback ?? "");
  return base ? `Re: ${base}` : fallback?.trim() || "Following up";
}

/** Moves the enrollment past `step`: next step's time inside the window, or completed. */
async function advance(db: SupabaseClient, e: EnrollmentRow, steps: StepRow[], step: StepRow, at: Date, threadId: string | null) {
  const next = steps.find((s) => s.position > step.position);
  const patch: Record<string, unknown> = next
    ? { current_step: next.position, next_send_at: nextStepSendTime(at, next.delay_days, windowOf(e.campaigns))?.toISOString() ?? null }
    : { current_step: step.position + 1, status: "completed", next_send_at: null };
  if (threadId && !e.gmail_thread_id) patch.gmail_thread_id = threadId;
  const { error } = await db.from("campaign_enrollments").update(patch).eq("id", e.id).eq("status", "active").eq("current_step", step.position);
  if (error) throw new Error(`advance enrollment: ${error.message}`);
  return next ?? null;
}

async function setNextSend(db: SupabaseClient, enrollmentId: string, at: Date | null) {
  if (!at) return; // window can never open (misconfigured) — leave queued untouched
  await db.from("campaign_enrollments").update({ next_send_at: at.toISOString() }).eq("id", enrollmentId).eq("status", "active");
}

// ── campaign.send_due ──────────────────────────────────────────────────────

interface Mailbox {
  conn: ConnectionRow;
  sender: { name: string | null; email: string };
  token: string | null;
  halted: boolean;
  queue: EnrollmentRow[];
}

type Outcome = "sent" | "skipped" | "deferred" | "stopped" | "halt" | "noop";

export interface SendSummary {
  due: number;
  sent: number;
  skipped: number;
  deferred: number;
  stopped: number;
  waiting: number; // mailbox not ready to send (sending off / no gmail.send scope / error)
  errors: number;
  leftForNextRun: number;
}

class SendRun {
  private steps = new Map<string, Promise<StepRow[]>>();
  private mailboxSent = new Map<string, number>(); // `${mailbox}|${tz}` → sent since local midnight
  private campaignSent = new Map<string, number>(); // campaign id → sent since local midnight

  constructor(readonly db: SupabaseClient) {}

  stepsFor(campaignId: string): Promise<StepRow[]> {
    let p = this.steps.get(campaignId);
    if (!p) {
      p = loadSteps(this.db, campaignId);
      this.steps.set(campaignId, p);
    }
    return p;
  }

  /** Remaining sends today for this mailbox (all campaigns, 40) and campaign (daily_cap), in the campaign's timezone. */
  async remaining(mailboxId: string, c: CampaignRow, now: Date): Promise<number> {
    const since = startOfLocalDay(now, c.timezone).toISOString();
    const mKey = `${mailboxId}|${c.timezone}`;
    if (!this.mailboxSent.has(mKey)) {
      const { count, error } = await this.db
        .from("campaign_messages")
        .select("id", { count: "exact", head: true })
        .eq("mailbox_connection_id", mailboxId)
        .in("status", SENT_STATUSES)
        .gte("sent_at", since);
      if (error) throw new Error(`count mailbox sends: ${error.message}`);
      this.mailboxSent.set(mKey, count ?? 0);
    }
    if (!this.campaignSent.has(c.id)) {
      const { count, error } = await this.db
        .from("campaign_messages")
        .select("id, campaign_enrollments!inner(campaign_id)", { count: "exact", head: true })
        .eq("campaign_enrollments.campaign_id", c.id)
        .in("status", SENT_STATUSES)
        .gte("sent_at", since);
      if (error) throw new Error(`count campaign sends: ${error.message}`);
      this.campaignSent.set(c.id, count ?? 0);
    }
    return remainingQuota(this.mailboxSent.get(mKey)!, this.campaignSent.get(c.id)!, c.daily_cap);
  }

  recordSend(mailboxId: string, campaignId: string) {
    for (const [k, v] of this.mailboxSent) if (k.startsWith(`${mailboxId}|`)) this.mailboxSent.set(k, v + 1);
    this.campaignSent.set(campaignId, (this.campaignSent.get(campaignId) ?? 0) + 1);
  }
}

export async function sendDueCampaignMessages(db: SupabaseClient): Promise<SendSummary> {
  const started = Date.now();
  const summary: SendSummary = { due: 0, sent: 0, skipped: 0, deferred: 0, stopped: 0, waiting: 0, errors: 0, leftForNextRun: 0 };

  const { data, error } = await db
    .from("campaign_enrollments")
    .select(ENROLLMENT_SELECT)
    .eq("status", "active")
    .lte("next_send_at", new Date().toISOString())
    .eq("campaigns.status", "active")
    .eq("campaigns.channel", "gmail")
    .not("campaigns.mailbox_connection_id", "is", null)
    .order("next_send_at", { ascending: true })
    .limit(MAX_DUE_PER_RUN);
  if (error) throw new Error(`load due enrollments: ${error.message}`);
  const due = (data ?? []) as unknown as EnrollmentRow[];
  summary.due = due.length;
  if (due.length === 0) return summary;

  const byMailbox = new Map<string, EnrollmentRow[]>();
  for (const e of due) {
    const id = e.campaigns.mailbox_connection_id!;
    byMailbox.set(id, [...(byMailbox.get(id) ?? []), e]);
  }

  const mailboxes: Mailbox[] = [];
  for (const [id, queue] of byMailbox) {
    let conn: ConnectionRow;
    try {
      conn = await getConnection(db, id);
    } catch {
      summary.waiting += queue.length;
      continue;
    }
    // Leave everything queued until the member switches sending on and grants gmail.send.
    if (!canSendFrom(conn)) {
      summary.waiting += queue.length;
      continue;
    }
    // A campaign may only send from a mailbox in its own workspace.
    const own = queue.filter((e) => e.campaigns.workspace_id === conn.workspace_id && e.workspace_id === conn.workspace_id);
    summary.waiting += queue.length - own.length;
    if (own.length === 0) continue;
    let senderName: string | null = null;
    if (conn.connected_by) {
      const { data: profile } = await db.from("profiles").select("full_name").eq("id", conn.connected_by).maybeSingle();
      senderName = (profile?.full_name as string | null) ?? null;
    }
    const email = (conn.external_account_id || conn.account_label || "").toLowerCase();
    mailboxes.push({ conn, sender: { name: senderName, email }, token: null, halted: false, queue: own });
  }

  // One message at a time per mailbox; round-robin so one busy mailbox can't starve the rest.
  const run = new SendRun(db);
  const outOfTime = () => Date.now() - started >= SEND_BUDGET_MS;
  while (!outOfTime() && mailboxes.some((m) => !m.halted && m.queue.length > 0)) {
    for (const mb of mailboxes) {
      if (mb.halted || mb.queue.length === 0) continue;
      if (outOfTime()) break;
      const e = mb.queue.shift()!;
      let outcome: Outcome;
      try {
        outcome = await processEnrollment(run, mb, e);
      } catch (err) {
        summary.errors++;
        console.error(`[gmail.send] enrollment ${e.id}: ${(err as Error).message}`);
        continue;
      }
      if (outcome === "sent") summary.sent++;
      else if (outcome === "skipped") summary.skipped++;
      else if (outcome === "deferred") summary.deferred++;
      else if (outcome === "stopped") summary.stopped++;
      else if (outcome === "halt") summary.waiting++;
    }
  }
  summary.leftForNextRun = mailboxes.reduce((n, m) => n + m.queue.length, 0);
  return summary;
}

async function processEnrollment(run: SendRun, mb: Mailbox, e: EnrollmentRow): Promise<Outcome> {
  const db = run.db;
  const c = e.campaigns;
  if (!isValidTimeZone(c.timezone)) {
    console.error(`[gmail.send] campaign ${c.id} has an invalid timezone; leaving queued`);
    return "noop";
  }
  const win = windowOf(c);

  const steps = await run.stepsFor(c.id);
  const step = steps.find((s) => s.position === e.current_step);
  if (!step) {
    await db.from("campaign_enrollments").update({ status: "completed", next_send_at: null }).eq("id", e.id).eq("status", "active");
    return "stopped";
  }

  const contact = await loadContact(db, e.contact_id);
  if (!contact) {
    await stopEnrollments(db, [e.id], "failed", "contact missing");
    return "stopped";
  }

  // Never email suppressed / unsubscribed / invalid addresses.
  const block = await blockFor(db, e.workspace_id, contact);
  if (block?.kind === "stop") {
    await stopEnrollments(db, [e.id], block.status, block.reason);
    return "stopped";
  }

  // Weekdays inside the campaign's hours only; otherwise reschedule to the next opening.
  const now = new Date();
  if (!isWithinWindow(now, win)) {
    await setNextSend(db, e.id, nextAllowedTime(now, win));
    return "deferred";
  }

  let msg = await loadMessage(db, e.id, step.position);
  if (msg?.status === "sent") {
    // Sent earlier but the enrollment wasn't advanced (crash) — repair, don't resend.
    await advance(db, e, steps, step, msg.sent_at ? new Date(msg.sent_at) : now, msg.gmail_thread_id);
    return "noop";
  }
  if (msg?.status === "bounced") {
    await stopEnrollments(db, [e.id], "stopped_bounce", "bounce");
    return "stopped";
  }
  if (msg?.status === "skipped") {
    // The team skipped this step in review.
    await advance(db, e, steps, step, now, null);
    return "skipped";
  }
  if (msg?.status === "sending") {
    if (Date.now() - new Date(msg.updated_at).getTime() < STALE_SENDING_MS) return "noop";
    // A previous run died mid-send: Gmail may or may not have accepted it. Never risk a duplicate.
    await db.from("campaign_messages").update({ status: "failed", error: "Send was interrupted; check the mailbox's Sent folder before retrying" }).eq("id", msg.id).eq("status", "sending");
    await stopEnrollments(db, [e.id], "failed", "send interrupted");
    return "stopped";
  }

  // Demo contacts: build the message so the sequence is visible, never send it.
  if (block?.kind === "demo") {
    if (msg) {
      await db.from("campaign_messages").update({ status: "skipped", error: "demo contact" }).eq("id", msg.id);
    } else {
      let content: { subject: string; body: string } = { subject: "", body: "" };
      try {
        content = await composeStep(db, e, step, contact);
      } catch {
        // drafting unavailable — still skip
      }
      await db.from("campaign_messages").upsert(
        {
          workspace_id: e.workspace_id,
          enrollment_id: e.id,
          step_position: step.position,
          subject: content.subject || null,
          body: content.body,
          status: "skipped",
          error: "demo contact",
          mailbox_connection_id: mb.conn.id,
        },
        { onConflict: "enrollment_id,step_position" },
      );
    }
    await advance(db, e, steps, step, now, null);
    return "skipped";
  }

  // 40/day per mailbox across campaigns, and the campaign's own daily cap.
  if ((await run.remaining(mb.conn.id, c, now)) <= 0) {
    await setNextSend(db, e.id, nextDayWindowStart(now, win));
    return "deferred";
  }

  // Use the reviewed draft if there is one; otherwise compose now.
  if (!msg) {
    let content: { subject: string; body: string };
    try {
      content = await composeStep(db, e, step, contact);
    } catch (err) {
      console.error(`[gmail.send] compose failed for enrollment ${e.id}: ${(err as Error).message}`);
      await setNextSend(db, e.id, nextAllowedTime(new Date(Date.now() + COMPOSE_RETRY_MS), win));
      return "deferred";
    }
    await db.from("campaign_messages").upsert(
      {
        workspace_id: e.workspace_id,
        enrollment_id: e.id,
        step_position: step.position,
        subject: content.subject || null,
        body: content.body,
        status: "scheduled",
        mailbox_connection_id: mb.conn.id,
        scheduled_for: now.toISOString(),
      },
      { onConflict: "enrollment_id,step_position", ignoreDuplicates: true },
    );
    msg = await loadMessage(db, e.id, step.position);
    if (!msg) throw new Error("campaign message missing after insert");
  }

  // Lock the row (draft/scheduled/failed → sending) so it can't be edited or sent twice.
  const messageId = msg.id;
  const { data: locked } = await db
    .from("campaign_messages")
    .update({ status: "sending", mailbox_connection_id: mb.conn.id, error: null })
    .eq("id", messageId)
    .in("status", ["draft", "scheduled", "failed"])
    .select("id, subject, body")
    .maybeSingle();
  if (!locked) return "noop";
  const revert = () => db.from("campaign_messages").update({ status: "scheduled" }).eq("id", messageId).eq("status", "sending");
  const skipLocked = (reason: string) =>
    db.from("campaign_messages").update({ status: "skipped", error: reason }).eq("id", messageId).eq("status", "sending");

  // The sequence may have stopped (reply/bounce/unsubscribe) since this run loaded it.
  const { data: fresh } = await db.from("campaign_enrollments").select("status").eq("id", e.id).maybeSingle();
  if (fresh?.status !== "active") {
    await skipLocked("sequence stopped");
    return "stopped";
  }

  let raw: string;
  let threadId: string | null = null;
  let subject: string;
  let threadEvent: ThreadEvent | null = null;
  try {
    if (!mb.token) mb.token = await gmailAccessToken(db, mb.conn.id);
    let inReplyTo: string | null = null;
    let references: string | null = null;
    if (step.position > 0 && e.gmail_thread_id) {
      // Follow-up: reply in the same thread (threadId + In-Reply-To/References + matching subject).
      threadId = e.gmail_thread_id;
      // Sync runs every ~10 min; check the thread itself so a fresh reply/bounce stops this follow-up.
      threadEvent = await inboundOnThread(mb.token, threadId, mb.sender.email);
      subject = await threadSubject(db, e, step.position, (locked.subject as string | null) ?? null);
      const prior = (await sentMessages(db, e.id, step.position)).filter((m) => m.gmail_message_id && m.gmail_thread_id === threadId);
      const last = prior[prior.length - 1];
      if (last?.gmail_message_id) {
        try {
          const meta = await getMessage(mb.token, last.gmail_message_id, { format: "metadata", metadataHeaders: ["Message-ID", "References"] });
          inReplyTo = headerValue(meta.payload?.headers, "Message-ID");
          const refs = headerValue(meta.payload?.headers, "References");
          references = [refs, inReplyTo].filter(Boolean).join(" ") || null;
        } catch {
          // Message deleted from the mailbox — threadId alone still files it in the thread.
        }
      }
    } else {
      subject = ((locked.subject as string | null) ?? "").trim() || (step.position > 0 ? await threadSubject(db, e, step.position, null) : "Quick question");
    }

    const urls = unsubscribeUrls(e.workspace_id, contact.email!);
    const body = `${String(locked.body).trimEnd()}\n\n\nIf you'd rather not get emails like this, you can unsubscribe here: ${urls.page}\n`;
    raw = encodeBase64Url(
      buildMimeMessage({
        from: mb.sender,
        to: { name: contact.full_name, email: contact.email! },
        subject,
        body,
        inReplyTo,
        references,
        listUnsubscribeUrl: urls.oneClick,
      }),
    );
  } catch (err) {
    await revert();
    mb.halted = true; // token refresh failed etc. (getAccessToken already marked the connection)
    console.error(`[gmail.send] mailbox ${mb.conn.id} not ready: ${(err as Error).message}`);
    return "halt";
  }

  if (threadEvent) {
    await skipLocked(threadEvent.kind === "bounce" ? "bounced" : "replied");
    const t: ThreadEnrollment = {
      enrollmentId: e.id,
      campaignId: c.id,
      campaignName: c.name,
      contactId: contact.id,
      accountId: e.account_id ?? contact.account_id,
      contactEmail: contact.email!.trim().toLowerCase(),
      contactName: contact.full_name,
    };
    if (threadEvent.kind === "bounce") await recordBounce(db, mb.conn, t);
    else await recordReply(db, mb.conn, t, threadEvent.from, { at: threadEvent.at });
    return "stopped";
  }

  let sent: { id: string; threadId: string };
  try {
    sent = await sendRawMessage(mb.token, raw, threadId);
  } catch (err) {
    return handleSendError(db, mb, e, messageId, err, revert);
  }

  const sentAt = new Date();
  run.recordSend(mb.conn.id, c.id);
  await db
    .from("campaign_messages")
    .update({ status: "sent", sent_at: sentAt.toISOString(), subject, gmail_message_id: sent.id, gmail_thread_id: sent.threadId, error: null })
    .eq("id", messageId);
  const next = await advance(db, e, steps, step, sentAt, sent.threadId);
  await db.from("activities").insert({
    workspace_id: e.workspace_id,
    account_id: e.account_id ?? contact.account_id,
    contact_id: contact.id,
    actor_id: mb.conn.connected_by,
    kind: "email_sent",
    title: `Email sent to ${contact.full_name}`,
    data: { campaign_id: c.id, campaign_name: c.name, enrollment_id: e.id, step: step.position, subject, gmail_message_id: sent.id, gmail_thread_id: sent.threadId },
    occurred_at: sentAt.toISOString(),
  });
  if (next) {
    // Pre-draft the next step so the team can review it before it goes out.
    try {
      await enqueue("campaign.draft", { enrollmentId: e.id }, { workspaceId: e.workspace_id, dedupeKey: `campaign.draft:${e.id}` });
    } catch (err) {
      console.error(`[gmail.send] could not enqueue next draft for ${e.id}: ${(err as Error).message}`);
    }
  }
  return "sent";
}

interface ThreadEvent {
  kind: "reply" | "bounce";
  from: { name: string | null; email: string };
  at: string | null;
}

/** First human reply or bounce on a campaign thread (headers only; the thread is ours with the prospect). */
async function inboundOnThread(token: string, threadId: string, mailbox: string): Promise<ThreadEvent | null> {
  let thread: { messages?: GmailMessage[] };
  try {
    thread = await getThreadMetadata(token, threadId, ["From", "Subject", "Auto-Submitted", "X-Autoreply", "X-Autorespond", "Precedence"]);
  } catch (err) {
    if (/→ 404:/.test((err as Error).message)) return null; // thread deleted from the mailbox
    throw err;
  }
  for (const m of thread.messages ?? []) {
    const headers = m.payload?.headers;
    const from = parseAddressList(headerValue(headers, "From"))[0];
    if (!from || from.email === mailbox || (m.labelIds ?? []).includes("SENT")) continue;
    const subject = headerValue(headers, "Subject");
    const at = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;
    if (isBounceMessage(from.email, subject)) return { kind: "bounce", from, at };
    if (isAutoReply(headers, subject) || isSystemSender(from.email)) continue;
    return { kind: "reply", from, at };
  }
  return null;
}

async function handleSendError(
  db: SupabaseClient,
  mb: Mailbox,
  e: EnrollmentRow,
  messageId: string,
  err: unknown,
  revert: () => PromiseLike<unknown>,
): Promise<Outcome> {
  const text = (err as Error).message ?? String(err);
  // UNVERIFIED: exact Gmail error reasons (e.g. insufficientPermissions, rateLimitExceeded,
  // userRateLimitExceeded, daily sending-limit errors); matched loosely below.
  if (err instanceof GmailSendError) {
    const reason = `${err.reason ?? ""} ${text}`;
    if (err.status === 429 || (err.status === 403 && /rate|quota|limit/i.test(reason))) {
      await revert(); // Gmail sending limit hit — try again next run
      mb.halted = true;
      return "halt";
    }
    if (err.status === 403 && /insufficient|scope/i.test(reason)) {
      // gmail.send was revoked: stop treating the mailbox as send-capable; keep messages queued.
      await revert();
      mb.halted = true;
      await db
        .from("integration_connections")
        .update({ scopes: mb.conn.scopes.filter((s) => s !== GMAIL_SEND_SCOPE), error: "Gmail send permission was revoked — reconnect with sending" })
        .eq("id", mb.conn.id);
      return "halt";
    }
    if (err.status === 401 || err.status === 403) {
      await revert();
      mb.halted = true;
      await markError(db, mb.conn.id, `Gmail rejected the send (${err.status}) — reconnect Gmail`);
      return "halt";
    }
    if (err.status >= 400 && err.status < 500) {
      // Message-level rejection (bad recipient, malformed message): fail this one, keep going.
      await db.from("campaign_messages").update({ status: "failed", error: text.slice(0, 500) }).eq("id", messageId);
      await stopEnrollments(db, [e.id], "failed", `send failed (${err.status})`);
      return "stopped";
    }
  }
  // 5xx / timeout / network: Gmail may have accepted it. Don't retry automatically (no duplicates).
  await db
    .from("campaign_messages")
    .update({ status: "failed", error: `Send result unknown (${text.slice(0, 200)}); check the Sent folder before retrying` })
    .eq("id", messageId);
  await stopEnrollments(db, [e.id], "failed", "send result unknown");
  return "stopped";
}

// ── campaign.draft ─────────────────────────────────────────────────────────

/** Pre-creates the next step's message as 'draft' (no-op when one already exists). */
export async function draftNextCampaignMessage(db: SupabaseClient, enrollmentId: string): Promise<{ drafted: boolean; reason?: string }> {
  const { data } = await db.from("campaign_enrollments").select(ENROLLMENT_SELECT).eq("id", enrollmentId).maybeSingle();
  const e = data as unknown as EnrollmentRow | null;
  if (!e || e.status !== "active") return { drafted: false, reason: "enrollment not active" };
  if (e.campaigns.channel !== "gmail") return { drafted: false, reason: "not a gmail campaign" };

  const steps = await loadSteps(db, e.campaign_id);
  const step = steps.find((s) => s.position === e.current_step);
  if (!step) return { drafted: false, reason: "no remaining step" };
  if (await loadMessage(db, e.id, step.position)) return { drafted: false, reason: "message exists" };

  const contact = await loadContact(db, e.contact_id);
  if (!contact) return { drafted: false, reason: "contact missing" };
  const block = await blockFor(db, e.workspace_id, contact);
  if (block?.kind === "stop") return { drafted: false, reason: block.reason };

  const content = await composeStep(db, e, step, contact);
  const subject = step.position > 0 && e.gmail_thread_id ? await threadSubject(db, e, step.position, content.subject || null) : content.subject;
  const { error } = await db.from("campaign_messages").upsert(
    {
      workspace_id: e.workspace_id,
      enrollment_id: e.id,
      step_position: step.position,
      subject: subject || null,
      body: content.body,
      status: "draft",
      mailbox_connection_id: e.campaigns.mailbox_connection_id,
      scheduled_for: e.next_send_at,
    },
    { onConflict: "enrollment_id,step_position", ignoreDuplicates: true },
  );
  if (error) throw new Error(`save draft: ${error.message}`);
  return { drafted: true };
}
