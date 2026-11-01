import type { Metadata } from "next";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { LinkedInUpload } from "./client";

export const metadata: Metadata = { title: "Network" };

export default async function NetworkPage() {
  const ctx = await requireWorkspace();
  const supabase = await createClient();
  const [{ count: mine }, { data: bySource }] = await Promise.all([
    supabase.from("network_connections").select("id", { count: "exact", head: true }).eq("workspace_id", ctx.workspace.id).eq("member_id", ctx.user.id).eq("source", "linkedin_export"),
    supabase.from("network_connections").select("source").eq("workspace_id", ctx.workspace.id).limit(20000),
  ]);
  const counts: Record<string, number> = {};
  for (const r of bySource ?? []) counts[r.source as string] = (counts[r.source as string] ?? 0) + 1;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="font-semibold">Your team&apos;s network</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Warm paths come only from data your team owns: people you&apos;ve emailed (Gmail), met (Granola), have in your CRM, or are connected to on LinkedIn via your own data export. Tidemark does not scrape LinkedIn.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["linkedin_export", "LinkedIn export"], ["gmail", "Gmail"], ["granola", "Meetings"], ["hubspot", "CRM"]].map(([k, l]) => (
          <div key={k} className="rounded-xl border bg-card p-3">
            <div className="text-xl font-semibold tabular-nums">{(counts[k] ?? 0) + (k === "hubspot" ? counts.attio ?? 0 : 0)}</div>
            <div className="text-xs text-muted-foreground">{l}</div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border bg-card p-5">
        <h3 className="font-medium">Upload your LinkedIn connections</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>On LinkedIn: Settings → Data privacy → Get a copy of your data → Connections.</li>
          <li>LinkedIn emails you a download; unzip it and upload <code className="rounded bg-muted px-1">Connections.csv</code> here.</li>
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">Only you can remove your connections. Teammates see them as intro paths, not as a list.</p>
        <div className="mt-4"><LinkedInUpload hasImport={(mine ?? 0) > 0} count={mine ?? 0} /></div>
      </div>
    </div>
  );
}
