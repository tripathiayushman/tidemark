import type { Metadata } from "next";
import { requireWorkspace, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { InviteForm } from "./client";
import { shortDate } from "@/lib/format";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const ctx = await requireWorkspace();
  const supabase = await createClient();
  const [{ data: members }, { data: invites }] = await Promise.all([
    supabase.from("workspace_members").select("user_id, role, created_at, profiles(full_name, email)").eq("workspace_id", ctx.workspace.id).order("created_at"),
    isAdmin(ctx.role) ? supabase.from("workspace_invites").select("id, email, role, token, accepted_at, expires_at").eq("workspace_id", ctx.workspace.id).is("accepted_at", null) : Promise.resolve({ data: [] }),
  ]);
  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="font-semibold">Members</h2>
      <ul className="divide-y rounded-xl border bg-card text-sm">
        {(members ?? []).map((m) => {
          const p = m.profiles as unknown as { full_name: string | null; email: string | null } | null;
          return (
            <li key={m.user_id as string} className="flex items-center justify-between px-4 py-2.5">
              <span><span className="font-medium">{p?.full_name ?? p?.email}</span>{p?.full_name ? <span className="ml-2 text-muted-foreground">{p.email}</span> : null}</span>
              <span className="text-xs capitalize text-muted-foreground">{m.role as string} · since {shortDate(m.created_at as string)}</span>
            </li>
          );
        })}
      </ul>
      {isAdmin(ctx.role) ? (
        <>
          <h2 className="font-semibold">Invite</h2>
          <InviteForm />
          {invites?.length ? (
            <ul className="divide-y rounded-xl border bg-card text-sm">
              {invites.map((i) => (
                <li key={i.id as string} className="flex items-center justify-between px-4 py-2.5">
                  <span>{i.email as string} <span className="text-xs capitalize text-muted-foreground">· {i.role as string}</span></span>
                  <span className="text-xs text-muted-foreground">pending · expires {shortDate(i.expires_at as string)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
