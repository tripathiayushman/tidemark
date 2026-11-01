import type { Metadata } from "next";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { IcpEditor } from "@/components/tm/icp-editor";
import { IcpListActions } from "./client";
import type { Icp } from "@/lib/types";

export const metadata: Metadata = { title: "ICP" };

export default async function IcpSettings(props: PageProps<"/settings/icp">) {
  const ctx = await requireWorkspace();
  const sp = await props.searchParams;
  const supabase = await createClient();
  const { data } = await supabase.from("icps").select("*").eq("workspace_id", ctx.workspace.id).eq("is_active", true).order("is_primary", { ascending: false }).order("created_at");
  const icps = (data ?? []) as Icp[];
  const editing = sp.new === "1" ? null : icps.find((i) => i.id === sp.edit) ?? icps[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {icps.map((i) => (
          <a key={i.id} href={`/settings/icp?edit=${i.id}`} className={`rounded-full border px-3 py-1 text-sm ${editing?.id === i.id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
            {i.name}{i.is_primary ? " · primary" : ""}
          </a>
        ))}
        <a href="/settings/icp?new=1" className={`rounded-full border border-dashed px-3 py-1 text-sm ${sp.new === "1" ? "border-primary" : "hover:bg-muted"}`}>+ New segment</a>
        {editing ? <IcpListActions id={editing.id} isPrimary={editing.is_primary} /> : null}
      </div>
      <IcpEditor
        key={editing?.id ?? "new"}
        showDrafting={!editing}
        initial={editing ? { id: editing.id, name: editing.name, description: editing.description, criteria: editing.criteria, buyer_roles: editing.buyer_roles, signal_preferences: editing.signal_preferences, is_primary: editing.is_primary } : null}
      />
      <p className="text-xs text-muted-foreground">Saving re-scores every account on this segment and looks for new matches.</p>
    </div>
  );
}
