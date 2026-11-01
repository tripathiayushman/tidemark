import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { MemberRole } from "@/lib/types";

// Data Access Layer: every server component / action / route that needs the
// user or workspace goes through here, so authorization lives in one place.

export const ACTIVE_WS_COOKIE = "tm_ws";

export interface CurrentUser {
  id: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
}

export interface WorkspaceContext {
  user: CurrentUser;
  workspace: {
    id: string;
    name: string;
    slug: string;
    website: string | null;
    timezone: string;
    onboarding_step: "company" | "knowledge" | "icp" | "done";
    kb_quota_bytes: number;
  };
  role: MemberRole;
  memberships: { id: string; name: string; role: MemberRole }[];
}

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, avatar_url, email")
    .eq("id", data.user.id)
    .maybeSingle();
  return {
    id: data.user.id,
    email: profile?.email ?? data.user.email ?? null,
    fullName: profile?.full_name ?? null,
    avatarUrl: profile?.avatar_url ?? null,
  };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Resolves the active workspace (cookie, else first membership). */
export const getWorkspaceContext = cache(async (): Promise<WorkspaceContext | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("workspace_members")
    .select("role, workspaces(id, name, slug, website, timezone, onboarding_step, kb_quota_bytes)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  type Row = { role: MemberRole; workspaces: WorkspaceContext["workspace"] | null };
  const memberships = ((rows ?? []) as unknown as Row[]).filter((r) => r.workspaces);
  if (memberships.length === 0) return null;

  const wanted = (await cookies()).get(ACTIVE_WS_COOKIE)?.value;
  const active = memberships.find((m) => m.workspaces!.id === wanted) ?? memberships[0];
  return {
    user,
    workspace: active.workspaces!,
    role: active.role,
    memberships: memberships.map((m) => ({ id: m.workspaces!.id, name: m.workspaces!.name, role: m.role })),
  };
});

/** For app pages: signed in, has a workspace, finished onboarding. */
export async function requireWorkspace(opts: { allowOnboarding?: boolean } = {}): Promise<WorkspaceContext> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const ctx = await getWorkspaceContext();
  if (!ctx) redirect("/onboarding");
  if (!opts.allowOnboarding && ctx.workspace.onboarding_step !== "done") redirect("/onboarding");
  return ctx;
}

export function isAdmin(role: MemberRole): boolean {
  return role === "owner" || role === "admin";
}
