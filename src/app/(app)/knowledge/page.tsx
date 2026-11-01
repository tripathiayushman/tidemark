import type { Metadata } from "next";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, Section } from "@/components/tm/page-header";
import { KnowledgeUploader } from "@/components/tm/knowledge-uploader";
import { AutoRefresh } from "@/components/tm/auto-refresh";
import { Progress } from "@/components/ui/progress";
import { bytes, shortDate } from "@/lib/format";
import { DocActions, SellerProfileForm, RefreshButton } from "./client";
import type { SellerProfile } from "@/lib/types";

export const metadata: Metadata = { title: "Knowledge" };

const STATUS_LABEL: Record<string, string> = { queued: "Queued", processing: "Reading…", ready: "Ready", failed: "Failed" };

export default async function KnowledgePage() {
  const ctx = await requireWorkspace();
  const supabase = await createClient();
  const [{ data: docs }, { data: seller }] = await Promise.all([
    supabase.from("kb_documents").select("id, name, kind, status, size_bytes, column_count, created_at, error, source_url").eq("workspace_id", ctx.workspace.id).order("created_at", { ascending: false }),
    supabase.from("seller_profiles").select("*").eq("workspace_id", ctx.workspace.id).maybeSingle(),
  ]);
  const used = (docs ?? []).reduce((s, d) => s + Number(d.size_bytes), 0);
  const quota = ctx.workspace.kb_quota_bytes;
  const busy = (docs ?? []).some((d) => d.status === "queued" || d.status === "processing");

  return (
    <div>
      <AutoRefresh active={busy} />
      <PageHeader title="Knowledge" description="What Tidemark knows about your company. It uses this to decide whether a company's changes create need for what you sell." actions={<RefreshButton />} />
      <div className="space-y-8 p-6">
        <div className="max-w-sm">
          <div className="mb-1.5 flex justify-between text-xs text-muted-foreground"><span>Storage</span><span className="tabular-nums">{bytes(used)} / {bytes(quota)}</span></div>
          <Progress value={Math.min(100, (used / quota) * 100)} />
        </div>
        <KnowledgeUploader defaultWebsite={ctx.workspace.website} />

        <Section title={`Files (${docs?.length ?? 0})`}>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Name</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">Size</th><th className="px-4 py-2.5 font-medium">Columns</th><th className="px-4 py-2.5 font-medium">Added</th><th /></tr>
              </thead>
              <tbody className="divide-y">
                {(docs ?? []).map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2.5"><span className="font-medium">{d.name}</span>{d.kind !== "upload" ? <span className="ml-2 text-xs text-muted-foreground">{d.kind}</span> : null}</td>
                    <td className="px-4 py-2.5">
                      <span className={d.status === "failed" ? "text-destructive" : d.status === "ready" ? "text-tier-s" : "text-muted-foreground"} title={d.error ?? undefined}>{STATUS_LABEL[d.status] ?? d.status}</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{bytes(Number(d.size_bytes))}</td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{d.column_count ?? "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{shortDate(d.created_at)}</td>
                    <td className="px-4 py-2.5 text-right"><DocActions id={d.id} /></td>
                  </tr>
                ))}
                {!docs?.length ? <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No files yet. Add your website or upload a playbook.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="What Tidemark understands about you">
          <SellerProfileForm profile={(seller as SellerProfile | null) ?? null} />
        </Section>
      </div>
    </div>
  );
}
