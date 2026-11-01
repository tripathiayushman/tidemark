"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceContext, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueue, type JobKind } from "@/lib/jobs";
import { unregisterInstantlyWebhook, listInstantlyCampaigns } from "@/lib/integrations/outreach/instantly";

async function ownConnection(id: string) {
  const ctx = await getWorkspaceContext();
  if (!ctx) throw new Error("No workspace");
  const supabase = await createClient();
  const { data } = await supabase.from("integration_connections").select("id, provider, connected_by, settings, scopes").eq("id", id).eq("workspace_id", ctx.workspace.id).single();
  if (!data) throw new Error("Connection not found");
  const canManage = isAdmin(ctx.role) || data.connected_by === ctx.user.id;
  return { ctx, supabase, conn: data, canManage };
}

/** Disconnect. Gmail: synced mail is deleted (FK cascade). CRMs: remote records stay. Instantly: our key copy is deleted. */
export async function disconnectIntegration(id: string) {
  const { ctx, conn, canManage } = await ownConnection(id);
  if (!canManage) return { error: "Only an admin or the person who connected it can disconnect" };
  const admin = createAdminClient();
  if (conn.provider === "instantly") {
    await unregisterInstantlyWebhook(admin, id).catch((e) => console.error(`[integrations] webhook cleanup: ${(e as Error).message}`));
  }
  const { error } = await admin.from("integration_connections").delete().eq("id", id).eq("workspace_id", ctx.workspace.id);
  if (error) return { error: error.message };
  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function syncNow(id: string) {
  const { ctx, conn } = await ownConnection(id);
  const kind: Record<string, JobKind> = { hubspot: "crm.pull", attio: "crm.pull", gmail: "gmail.sync", granola: "granola.sync" };
  const k = kind[conn.provider as string];
  if (!k) return { error: "Nothing to sync for this integration" };
  await enqueue(k, { connectionId: id } as never, { workspaceId: ctx.workspace.id, dedupeKey: `${k}:${id}`, priority: 15 });
  if (conn.provider === "hubspot" || conn.provider === "attio") {
    await enqueue("crm.push", { connectionId: id }, { workspaceId: ctx.workspace.id, dedupeKey: `crm.push:${id}`, priority: 16 });
  }
  return { ok: true };
}

export async function updateGmailSettings(id: string, patch: { sending_enabled?: boolean; prospect_scope?: "qualified" | "owned" }) {
  const { ctx, conn, canManage } = await ownConnection(id);
  if (conn.provider !== "gmail") return { error: "Not a Gmail connection" };
  if (!canManage) return { error: "Only the mailbox owner can change this" };
  if (patch.sending_enabled && !(conn.scopes as string[]).some((s) => s.endsWith("gmail.send"))) {
    return { error: "needs_send_scope" };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("integration_connections")
    .update({ settings: { ...(conn.settings as Record<string, unknown>), ...patch } })
    .eq("id", id)
    .eq("workspace_id", ctx.workspace.id);
  if (error) return { error: error.message };
  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function instantlyCampaigns(connectionId: string) {
  await ownConnection(connectionId);
  try {
    return { campaigns: await listInstantlyCampaigns(createAdminClient(), connectionId) };
  } catch (e) {
    return { error: (e as Error).message, campaigns: [] };
  }
}
