"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ACTIVE_WS_COOKIE, getWorkspaceContext, isAdmin, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { enqueue } from "@/lib/jobs";

export async function switchWorkspace(workspaceId: string) {
  const user = await requireUser();
  const supabase = await createClient();
  const { data } = await supabase.from("workspace_members").select("workspace_id").eq("user_id", user.id).eq("workspace_id", workspaceId).maybeSingle();
  if (!data) throw new Error("Not a member of that workspace");
  (await cookies()).set(ACTIVE_WS_COOKIE, workspaceId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
  redirect("/home");
}

export async function createWorkspace(formData: FormData) {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  const website = String(formData.get("website") ?? "").trim();
  if (!name) return { error: "Give your workspace a name" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_workspace", { p_name: name, p_website: website || null });
  if (error) return { error: error.message };
  const ws = data as { id: string };
  (await cookies()).set(ACTIVE_WS_COOKIE, ws.id, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  await supabase.from("workspaces").update({ onboarding_step: "knowledge" }).eq("id", ws.id);
  return { ok: true, workspaceId: ws.id };
}

export async function setOnboardingStep(step: "company" | "knowledge" | "icp" | "done") {
  const ctx = await getWorkspaceContext();
  if (!ctx) throw new Error("No workspace");
  const supabase = await createClient();
  await supabase.from("workspaces").update({ onboarding_step: step }).eq("id", ctx.workspace.id);
  if (step === "done") {
    await enqueue("workspace.match", { workspaceId: ctx.workspace.id }, { workspaceId: ctx.workspace.id, dedupeKey: `match:${ctx.workspace.id}`, priority: 20 });
  }
  revalidatePath("/", "layout");
}

export async function updateWorkspace(formData: FormData) {
  const ctx = await getWorkspaceContext();
  if (!ctx || !isAdmin(ctx.role)) return { error: "Only admins can change workspace settings" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .update({
      name: String(formData.get("name") ?? ctx.workspace.name).trim() || ctx.workspace.name,
      website: String(formData.get("website") ?? "").trim() || null,
      timezone: String(formData.get("timezone") ?? ctx.workspace.timezone),
    })
    .eq("id", ctx.workspace.id);
  if (error) return { error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function inviteMember(formData: FormData) {
  const ctx = await getWorkspaceContext();
  if (!ctx || !isAdmin(ctx.role)) return { error: "Only admins can invite" };
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = formData.get("role") === "admin" ? "admin" : "member";
  if (!email.includes("@")) return { error: "Enter an email" };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_invites")
    .upsert({ workspace_id: ctx.workspace.id, email, role, invited_by: ctx.user.id }, { onConflict: "workspace_id,email" })
    .select("token")
    .single();
  if (error) return { error: error.message };
  revalidatePath("/settings/team");
  return { ok: true, token: data.token as string };
}
