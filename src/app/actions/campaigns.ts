"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { enqueue } from "@/lib/jobs";

async function ctxDb() {
  const ctx = await getWorkspaceContext();
  if (!ctx) throw new Error("No workspace");
  return { ctx, db: await createClient() };
}

const DEFAULT_STEPS = [
  { position: 0, delay_days: 0, subject_template: "", body_template: "Reference the strongest record and ask one question about their timeline.", ai_draft: true },
  { position: 1, delay_days: 3, subject_template: "", body_template: "Short follow-up with one new angle (a proof point or a relevant detail from another record).", ai_draft: true },
  { position: 2, delay_days: 5, subject_template: "", body_template: "Brief close-the-loop note; offer to send something useful instead of a meeting.", ai_draft: true },
];

export async function createCampaign(input: { name: string; channel: "gmail" | "instantly"; mailboxConnectionId?: string | null; instantlyConnectionId?: string | null; instantlyCampaignId?: string | null }) {
  const { ctx, db } = await ctxDb();
  if (!input.name.trim()) return { error: "Name the campaign" };
  if (input.channel === "gmail" && !input.mailboxConnectionId) return { error: "Pick a Gmail mailbox (connect one in Settings → Integrations)" };
  if (input.channel === "instantly" && (!input.instantlyConnectionId || !input.instantlyCampaignId)) return { error: "Pick an Instantly campaign" };
  const { data, error } = await db.from("campaigns").insert({
    workspace_id: ctx.workspace.id, name: input.name.trim(), channel: input.channel,
    mailbox_connection_id: input.mailboxConnectionId ?? null, instantly_connection_id: input.instantlyConnectionId ?? null,
    instantly_campaign_id: input.instantlyCampaignId ?? null, timezone: ctx.workspace.timezone, created_by: ctx.user.id,
  }).select("id").single();
  if (error) return { error: error.message };
  if (input.channel === "gmail") {
    await db.from("campaign_steps").insert(DEFAULT_STEPS.map((s) => ({ ...s, campaign_id: data.id, workspace_id: ctx.workspace.id })));
  }
  revalidatePath("/campaigns");
  return { ok: true, id: data.id as string };
}

export async function updateCampaignSettings(id: string, patch: { name?: string; sending_days?: number[]; send_window_start?: string; send_window_end?: string; timezone?: string; daily_cap?: number }) {
  const { ctx, db } = await ctxDb();
  if (patch.daily_cap != null) patch.daily_cap = Math.max(1, Math.min(40, Math.round(patch.daily_cap)));
  if (patch.sending_days) patch.sending_days = patch.sending_days.filter((d) => d >= 1 && d <= 5);
  const { error } = await db.from("campaigns").update(patch).eq("id", id).eq("workspace_id", ctx.workspace.id);
  if (error) return { error: error.message };
  revalidatePath(`/campaigns/${id}`);
  return { ok: true };
}

export async function saveSteps(campaignId: string, steps: { position: number; delay_days: number; subject_template: string; body_template: string; ai_draft: boolean }[]) {
  const { ctx, db } = await ctxDb();
  await db.from("campaign_steps").delete().eq("campaign_id", campaignId).eq("workspace_id", ctx.workspace.id);
  const { error } = await db.from("campaign_steps").insert(
    steps.map((s, i) => ({ ...s, position: i, delay_days: i === 0 ? 0 : Math.max(1, s.delay_days), campaign_id: campaignId, workspace_id: ctx.workspace.id })),
  );
  if (error) return { error: error.message };
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true };
}

/** Enroll the best contacts at each account (decision makers first; verified or unverified email; never invalid/unsubscribed/suppressed). */
export async function enrollAccounts(campaignId: string, accountIds: string[], perAccount = 1) {
  const { ctx, db } = await ctxDb();
  const { data: campaign } = await db.from("campaigns").select("id, status, channel").eq("id", campaignId).eq("workspace_id", ctx.workspace.id).single();
  if (!campaign) return { error: "Campaign not found" };
  const { data: contacts } = await db
    .from("contacts")
    .select("id, account_id, email, email_status, role_tag, unsubscribed_at")
    .in("account_id", accountIds)
    .not("email", "is", null)
    .is("unsubscribed_at", null)
    .neq("email_status", "invalid");
  const { data: supp } = await db.from("suppressions").select("email").eq("workspace_id", ctx.workspace.id);
  const suppressed = new Set((supp ?? []).map((s) => String(s.email).toLowerCase()));
  const rank = { decision_maker: 0, runs_the_build: 1, champion: 2, influencer: 3, other: 4 } as Record<string, number>;
  const chosen: { contact_id: string; account_id: string }[] = [];
  for (const acc of accountIds) {
    const pool = (contacts ?? []).filter((c) => c.account_id === acc && !suppressed.has(String(c.email).toLowerCase()))
      .sort((a, b) => (rank[a.role_tag] ?? 9) - (rank[b.role_tag] ?? 9) || (a.email_status === "valid" ? -1 : 1));
    for (const c of pool.slice(0, perAccount)) chosen.push({ contact_id: c.id, account_id: acc });
  }
  if (!chosen.length) return { error: "No contacts with a usable email at those accounts yet" };
  const active = campaign.status === "active";
  const { data: rows, error } = await db.from("campaign_enrollments").upsert(
    chosen.map((c) => ({
      ...c, workspace_id: ctx.workspace.id, campaign_id: campaignId, enrolled_by: ctx.user.id, status: "active",
      next_send_at: active && campaign.channel === "gmail" ? new Date().toISOString() : null,
    })),
    { onConflict: "campaign_id,contact_id", ignoreDuplicates: true },
  ).select("id");
  if (error) return { error: error.message };
  const ids = (rows ?? []).map((r) => r.id as string);
  for (const c of chosen) {
    await db.from("activities").insert({ workspace_id: ctx.workspace.id, account_id: c.account_id, contact_id: c.contact_id, actor_id: ctx.user.id, kind: "campaign_enrolled", title: "Added to a campaign" });
  }
  if (ids.length) {
    if (campaign.channel === "instantly" && active) {
      await enqueue("instantly.push", { campaignId, enrollmentIds: ids }, { workspaceId: ctx.workspace.id, priority: 30 });
    } else if (campaign.channel === "gmail") {
      for (const id of ids) await enqueue("campaign.draft", { enrollmentId: id }, { workspaceId: ctx.workspace.id, dedupeKey: `draft:${id}`, priority: 60 });
    }
  }
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true, enrolled: ids.length, skipped: chosen.length - ids.length };
}

export async function setCampaignStatus(id: string, status: "active" | "paused" | "archived") {
  const { ctx, db } = await ctxDb();
  const { data: c } = await db.from("campaigns").select("id, channel, status").eq("id", id).eq("workspace_id", ctx.workspace.id).single();
  if (!c) return { error: "Campaign not found" };
  const patch: Record<string, unknown> = { status };
  if (status === "active" && c.status !== "active") patch.launched_at = new Date().toISOString();
  const { error } = await db.from("campaigns").update(patch).eq("id", id);
  if (error) return { error: error.message };
  if (status === "active") {
    if (c.channel === "gmail") {
      await db.from("campaign_enrollments").update({ next_send_at: new Date().toISOString() }).eq("campaign_id", id).eq("status", "active").is("next_send_at", null);
      await enqueue("campaign.send_due", {}, { dedupeKey: "campaign.send_due", priority: 40 });
    } else {
      const { data: pending } = await db.from("campaign_enrollments").select("id").eq("campaign_id", id).eq("status", "active").is("external_lead_id", null);
      if (pending?.length) await enqueue("instantly.push", { campaignId: id, enrollmentIds: pending.map((p) => p.id as string) }, { workspaceId: ctx.workspace.id, priority: 30 });
    }
  }
  revalidatePath(`/campaigns/${id}`);
  return { ok: true };
}

export async function stopEnrollment(id: string) {
  const { ctx, db } = await ctxDb();
  const { data } = await db.from("campaign_enrollments").update({ status: "stopped_manual", stopped_at: new Date().toISOString(), stop_reason: "Stopped by user", next_send_at: null }).eq("id", id).eq("workspace_id", ctx.workspace.id).select("campaign_id").single();
  if (data) revalidatePath(`/campaigns/${data.campaign_id}`);
}

export async function updateDraft(id: string, subject: string, body: string) {
  const { ctx, db } = await ctxDb();
  const { data, error } = await db.from("campaign_messages").update({ subject, body }).eq("id", id).eq("workspace_id", ctx.workspace.id).in("status", ["draft", "scheduled"]).select("enrollment_id").single();
  if (error) return { error: error.message };
  return { ok: true, enrollmentId: data.enrollment_id as string };
}

export async function skipDraft(id: string) {
  const { ctx, db } = await ctxDb();
  await db.from("campaign_messages").update({ status: "skipped" }).eq("id", id).eq("workspace_id", ctx.workspace.id).in("status", ["draft", "scheduled"]);
}
