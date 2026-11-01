"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { enqueue } from "@/lib/jobs";
import type { AccountStatus } from "@/lib/types";

async function ctxOrThrow() {
  const ctx = await getWorkspaceContext();
  if (!ctx) throw new Error("No workspace");
  return ctx;
}

async function ownAccount(id: string) {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  const { data } = await supabase.from("accounts").select("id, workspace_id, status").eq("id", id).eq("workspace_id", ctx.workspace.id).single();
  if (!data) throw new Error("Account not found");
  return { ctx, supabase, account: data };
}

export async function setAccountStatus(id: string, status: AccountStatus) {
  const { ctx, supabase, account } = await ownAccount(id);
  await supabase.from("accounts").update({ status }).eq("id", id);
  await supabase.from("activities").insert({
    workspace_id: ctx.workspace.id, account_id: id, actor_id: ctx.user.id, kind: "status_change",
    title: `Status: ${account.status} → ${status}`,
  });
  revalidatePath(`/prospects/${id}`);
}

export async function setAccountOwner(id: string, ownerId: string | null) {
  const { supabase } = await ownAccount(id);
  await supabase.from("accounts").update({ owner_id: ownerId }).eq("id", id);
  revalidatePath(`/prospects/${id}`);
}

export async function reResearch(id: string) {
  const { ctx } = await ownAccount(id);
  await enqueue("account.research", { accountId: id, force: true }, { workspaceId: ctx.workspace.id, dedupeKey: `research:${id}`, priority: 10 });
  revalidatePath(`/prospects/${id}`);
}

export async function findContacts(id: string) {
  const { ctx } = await ownAccount(id);
  await enqueue("account.contacts", { accountId: id }, { workspaceId: ctx.workspace.id, dedupeKey: `contacts:${id}`, priority: 10 });
  await enqueue("account.warm_paths", { accountId: id }, { workspaceId: ctx.workspace.id, dedupeKey: `warm:${id}`, priority: 15, runAfter: new Date(Date.now() + 20_000) });
}

export async function addNote(id: string, text: string) {
  const { ctx, supabase } = await ownAccount(id);
  if (!text.trim()) return;
  await supabase.from("activities").insert({ workspace_id: ctx.workspace.id, account_id: id, actor_id: ctx.user.id, kind: "note", title: "Note", body: text.trim() });
  revalidatePath(`/prospects/${id}`);
}

export async function createTask(input: { accountId?: string | null; contactId?: string | null; title: string; dueOn?: string | null; assigneeId?: string | null; kind?: string }) {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  if (!input.title.trim()) return { error: "Give the task a title" };
  const { error } = await supabase.from("tasks").insert({
    workspace_id: ctx.workspace.id, account_id: input.accountId ?? null, contact_id: input.contactId ?? null,
    title: input.title.trim(), due_on: input.dueOn || null, assignee_id: input.assigneeId ?? ctx.user.id,
    created_by: ctx.user.id, kind: input.kind ?? "custom", source: "user",
  });
  if (error) return { error: error.message };
  revalidatePath("/tasks");
  if (input.accountId) revalidatePath(`/prospects/${input.accountId}`);
  return { ok: true };
}

export async function setTaskStatus(id: string, status: "open" | "done" | "dismissed") {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  const { data } = await supabase
    .from("tasks")
    .update({ status, completed_at: status === "done" ? new Date().toISOString() : null })
    .eq("id", id)
    .eq("workspace_id", ctx.workspace.id)
    .select("account_id, title")
    .single();
  if (data?.account_id && status === "done") {
    await supabase.from("activities").insert({ workspace_id: ctx.workspace.id, account_id: data.account_id, actor_id: ctx.user.id, kind: "task_done", title: `Done: ${data.title}` });
  }
  revalidatePath("/tasks");
  if (data?.account_id) revalidatePath(`/prospects/${data.account_id}`);
}

export async function addToList(accountIds: string[], listName: string) {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  const name = listName.trim();
  if (!name) return { error: "Name the list" };
  let { data: list } = await supabase.from("lists").select("id").eq("workspace_id", ctx.workspace.id).eq("name", name).maybeSingle();
  if (!list) {
    const created = await supabase.from("lists").insert({ workspace_id: ctx.workspace.id, name, created_by: ctx.user.id }).select("id").single();
    if (created.error) return { error: created.error.message };
    list = created.data;
  }
  const { error } = await supabase
    .from("list_members")
    .upsert(accountIds.map((account_id) => ({ list_id: list!.id, account_id, workspace_id: ctx.workspace.id })), { onConflict: "list_id,account_id", ignoreDuplicates: true });
  if (error) return { error: error.message };
  for (const id of accountIds) revalidatePath(`/prospects/${id}`);
  return { ok: true };
}

export async function pushToCrm(accountIds: string[]) {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  const { data: conns } = await supabase
    .from("integration_connections")
    .select("id, provider")
    .eq("workspace_id", ctx.workspace.id)
    .in("provider", ["hubspot", "attio"])
    .eq("status", "active");
  if (!conns?.length) return { error: "Connect HubSpot or Attio in Settings → Integrations first" };
  for (const c of conns) {
    await enqueue("crm.push", { connectionId: c.id, accountIds }, { workspaceId: ctx.workspace.id, priority: 20 });
  }
  return { ok: true, providers: conns.map((c) => c.provider) };
}

export async function updateContact(id: string, patch: { role_tag?: string; title?: string; phone?: string; email?: string }) {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
  if (patch.email !== undefined) { clean.email_status = "unverified"; clean.email_verified_at = null; }
  const { data } = await supabase.from("contacts").update(clean).eq("id", id).eq("workspace_id", ctx.workspace.id).select("account_id").single();
  if (data?.account_id) revalidatePath(`/prospects/${data.account_id}`);
}

export async function addContact(accountId: string, input: { full_name: string; title?: string; email?: string; phone?: string; role_tag?: string }) {
  const { ctx, supabase } = await ownAccount(accountId);
  const { data: acc } = await supabase.from("accounts").select("company_id").eq("id", accountId).single();
  const { error } = await supabase.from("contacts").insert({
    workspace_id: ctx.workspace.id, account_id: accountId, company_id: acc?.company_id ?? null,
    full_name: input.full_name.trim(), title: input.title || null, email: input.email?.trim().toLowerCase() || null,
    phone: input.phone || null, role_tag: input.role_tag ?? "other", source: "manual", created_by: ctx.user.id,
  });
  if (error) return { error: error.message };
  revalidatePath(`/prospects/${accountId}`);
  return { ok: true };
}
