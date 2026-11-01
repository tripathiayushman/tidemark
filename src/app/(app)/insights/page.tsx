import type { Metadata } from "next";
import { Lightbulb } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, Section, EmptyState } from "@/components/tm/page-header";
import { BarList } from "@/components/tm/bar-list";
import { SIGNAL_CATEGORY_LABEL, type SignalCategory, type Tier } from "@/lib/types";
import { InsightActions, RegenerateButton } from "./client";
import { ago } from "@/lib/format";

export const metadata: Metadata = { title: "Insights" };

interface Stats {
  watched: number; researching: number; qualified: number; new_this_week: number; windows_closing: number;
  open_tasks: number; with_warm_path: number; tier_counts: Partial<Record<Tier, number>>;
  signals_by_category: Partial<Record<SignalCategory, number>>;
}

export default async function InsightsPage() {
  const ctx = await requireWorkspace();
  const supabase = await createClient();
  const [{ data: statsRaw }, { data: insights }, { data: accts }, { data: icps }, { count: noContact }] = await Promise.all([
    supabase.rpc("workspace_stats", { p_workspace_id: ctx.workspace.id }),
    supabase.from("insights").select("id, kind, title, body, generated_at").eq("workspace_id", ctx.workspace.id).is("dismissed_at", null).order("generated_at", { ascending: false }),
    supabase.from("accounts").select("icp_id, research_status, tier").eq("workspace_id", ctx.workspace.id).limit(10000),
    supabase.from("icps").select("id, name").eq("workspace_id", ctx.workspace.id),
    supabase.from("prospect_rows").select("id", { count: "exact", head: true }).eq("workspace_id", ctx.workspace.id).eq("research_status", "qualified").is("top_contact_id", null),
  ]);
  const s = (statsRaw ?? {}) as Stats;
  const qualifyRate = s.watched ? Math.round((s.qualified / s.watched) * 100) : 0;

  const icpName = new Map((icps ?? []).map((i) => [i.id as string, i.name as string]));
  const seg = new Map<string, { name: string; watched: number; qualified: number; tierS: number; outside: number }>();
  for (const a of accts ?? []) {
    const key = (a.icp_id as string) ?? "none";
    const row = seg.get(key) ?? { name: icpName.get(key) ?? "Unassigned", watched: 0, qualified: 0, tierS: 0, outside: 0 };
    row.watched++;
    if (a.research_status === "qualified") { row.qualified++; if (a.tier === "S") row.tierS++; }
    if (a.research_status === "disqualified") row.outside++;
    seg.set(key, row);
  }

  const tiles = [
    { label: "Prospects", value: s.qualified ?? 0, note: `${qualifyRate}% of ${s.watched ?? 0} watched` },
    { label: "Tier S", value: s.tier_counts?.S ?? 0, note: "strongest fit + timing" },
    { label: "With a warm intro", value: s.with_warm_path ?? 0, note: s.qualified ? `${Math.round(((s.with_warm_path ?? 0) / s.qualified) * 100)}% of prospects` : "—" },
    { label: "Missing contacts", value: noContact ?? 0, note: "qualified, no person yet" },
    { label: "Windows closing", value: s.windows_closing ?? 0, note: "in the next 14 days" },
  ];

  return (
    <div>
      <PageHeader title="Insights" description="How your targeting is performing and where the gaps are." actions={<RegenerateButton />} />
      <div className="space-y-8 p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl border bg-card p-4">
              <div className="text-2xl font-semibold tabular-nums">{t.value.toLocaleString()}</div>
              <div className="mt-1 text-xs font-medium">{t.label}</div>
              <div className="text-xs text-muted-foreground">{t.note}</div>
            </div>
          ))}
        </div>

        <Section title="Observations">
          {insights?.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {insights.map((i) => (
                <article key={i.id} className="rounded-xl border bg-card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-medium">{i.title}</h3>
                    <InsightActions id={i.id} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{i.body}</p>
                  <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">{i.kind.replace("_", " ")} · {ago(i.generated_at)}</p>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Lightbulb className="size-6" />} title="No observations yet">Tidemark writes these daily once prospects start qualifying. You can also regenerate now.</EmptyState>
          )}
        </Section>

        <div className="grid gap-8 lg:grid-cols-2">
          <Section title="Prospects by tier">
            <BarList
              label="Qualified prospects by tier"
              unit="prospects"
              rows={(["S", "A", "B"] as Tier[]).map((t) => ({ key: t, label: `Tier ${t}`, value: s.tier_counts?.[t] ?? 0 }))}
            />
          </Section>
          <Section title="Evidence by signal type">
            <BarList
              label="Records cited as evidence, by signal category"
              unit="records"
              sort
              rows={(Object.keys(SIGNAL_CATEGORY_LABEL) as SignalCategory[]).map((c) => ({ key: c, label: SIGNAL_CATEGORY_LABEL[c], value: s.signals_by_category?.[c] ?? 0 }))}
            />
          </Section>
        </div>

        <Section title="Segments">
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Segment</th>
                  <th className="px-4 py-2.5 text-right font-medium">Watched</th>
                  <th className="px-4 py-2.5 text-right font-medium">Qualified</th>
                  <th className="px-4 py-2.5 font-medium">Qualify rate</th>
                  <th className="px-4 py-2.5 text-right font-medium">Tier S</th>
                  <th className="px-4 py-2.5 text-right font-medium">Outside ICP</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[...seg.values()].map((r) => {
                  const rate = r.watched ? r.qualified / r.watched : 0;
                  return (
                    <tr key={r.name}>
                      <td className="px-4 py-2.5 font-medium">{r.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.watched}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.qualified}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 rounded-full bg-muted" role="meter" aria-valuenow={Math.round(rate * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${r.name} qualify rate`}>
                            <div className="h-1.5 rounded-full bg-chart-bar" style={{ width: `${Math.round(rate * 100)}%` }} />
                          </div>
                          <span className="tabular-nums text-muted-foreground">{Math.round(rate * 100)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.tierS}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.outside}</td>
                    </tr>
                  );
                })}
                {!seg.size ? <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No accounts yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </div>
  );
}
