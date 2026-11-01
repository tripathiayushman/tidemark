import type { Metadata } from "next";
import Link from "next/link";
import { Target } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/tm/page-header";
import { DemoTag, ResearchStatusText, TierBadge } from "@/components/tm/badges";
import { ProspectToolbar } from "./toolbar";
import { isoFromNow, shortDate, windowLabel, initials } from "@/lib/format";
import type { ResearchStatus, Tier } from "@/lib/types";
import { AutoRefresh } from "@/components/tm/auto-refresh";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Prospects" };

const PAGE_SIZE = 25;
const SORTS: Record<string, { col: string; asc: boolean }> = {
  score: { col: "score", asc: false },
  window: { col: "contact_window_end", asc: true },
  recent: { col: "qualified_at", asc: false },
  name: { col: "company_name", asc: true },
  signal: { col: "last_signal_on", asc: false },
};

export default async function ProspectsPage(props: PageProps<"/prospects">) {
  const ctx = await requireWorkspace();
  const sp = await props.searchParams;
  const get = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const tab = get("tab") || "all";
  const q = get("q");
  const tier = get("tier");
  const status = get("status");
  const icp = get("icp");
  const sort = SORTS[get("sort")] ? get("sort") : tab === "watching" ? "signal" : "score";
  const page = Math.max(1, Number(get("page")) || 1);

  const supabase = await createClient();
  let query = supabase
    .from("prospect_rows")
    .select("*", { count: "exact" })
    .eq("workspace_id", ctx.workspace.id);

  if (tab === "watching") {
    if (status) query = query.eq("research_status", status);
  } else {
    query = query.eq("research_status", "qualified");
    if (tab === "new") query = query.gte("qualified_at", isoFromNow(-7));
    if (tab === "tier_s") query = query.eq("tier", "S");
    if (tab === "mine") query = query.eq("owner_id", ctx.user.id);
    if (status) query = query.eq("status", status);
  }
  if (tier) query = query.eq("tier", tier);
  if (icp) query = query.eq("icp_id", icp);
  if (q) query = query.or(`company_name.ilike.%${q.replace(/[%,()]/g, "")}%,reason_to_buy.ilike.%${q.replace(/[%,()]/g, "")}%,industry.ilike.%${q.replace(/[%,()]/g, "")}%`);
  const s = SORTS[sort];
  query = query.order(s.col, { ascending: s.asc, nullsFirst: false }).order("score", { ascending: false, nullsFirst: false });
  const { data: rows, count } = await query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  const [{ data: icps }, counts, { count: active }] = await Promise.all([
    supabase.from("icps").select("id, name").eq("workspace_id", ctx.workspace.id).eq("is_active", true),
    tabCounts(supabase, ctx.workspace.id, ctx.user.id),
    supabase.from("accounts").select("id", { count: "exact", head: true }).eq("workspace_id", ctx.workspace.id).in("research_status", ["queued", "researching", "checking"]),
  ]);

  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tabs = [
    { key: "all", label: "All", n: counts.all },
    { key: "new", label: "New this week", n: counts.new },
    { key: "tier_s", label: "Tier S", n: counts.s },
    { key: "mine", label: "Mine", n: counts.mine },
    { key: "watching", label: "Watching", n: counts.watching },
  ];
  const href = (patch: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, q, tier, status, icp, sort: get("sort"), page: String(page), ...patch })) if (v) p.set(k, String(v));
    return `/prospects?${p}`;
  };

  return (
    <div>
      <AutoRefresh active={(active ?? 0) > 0} intervalMs={8000} />
      <PageHeader
        title="Prospects"
        description={tab === "watching" ? `${counts.watching.toLocaleString()} companies watched · ${active ?? 0} being researched` : `${total.toLocaleString()} prospect${total === 1 ? "" : "s"}, ranked by fit and timing`}
      />
      <div className="px-6 pt-4">
        <nav className="flex gap-1 overflow-x-auto border-b">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={href({ tab: t.key, page: 1, status: null })}
              className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm", tab === t.key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              {t.label} <span className="ml-1 text-xs tabular-nums text-muted-foreground">{t.key === "mine" ? `${t.n} of ${counts.all}` : t.n}</span>
            </Link>
          ))}
        </nav>
        <ProspectToolbar tab={tab} icps={icps ?? []} />
      </div>

      <div className="px-6 pb-8">
        {!rows?.length ? (
          <EmptyState icon={<Target className="size-6" />} title={tab === "watching" ? "No companies on the watchlist yet" : "No prospects match"}>
            {tab === "watching" ? "Companies appear here as public records match your ICP." : "Try another tab or clear filters. Companies qualify when several dated records point to a reason to buy."}
          </EmptyState>
        ) : tab === "watching" ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Company</th><th className="px-4 py-2.5 font-medium">Industry</th><th className="px-4 py-2.5 font-medium">Latest record</th><th className="px-4 py-2.5 font-medium">Score</th><th className="px-4 py-2.5 font-medium">Matched</th></tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/40">
                    <td className="px-4 py-2.5"><Link href={`/prospects/${r.id}`} className="font-medium hover:underline">{r.company_name}</Link> {r.is_synthetic ? <DemoTag /> : null}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.industry ?? r.naics_title ?? "—"}</td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{shortDate(r.last_signal_on)}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.score ?? "—"}</td>
                    <td className="px-4 py-2.5"><ResearchStatusText status={r.research_status as ResearchStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-2 py-2.5 font-medium">Tier</th>
                  <th className="px-4 py-2.5 font-medium">Reason to buy</th>
                  <th className="px-4 py-2.5 font-medium">Contact window</th>
                  <th className="px-4 py-2.5 font-medium">Who to contact</th>
                  <th className="px-4 py-2.5 font-medium">Can introduce</th>
                  <th className="px-4 py-2.5 font-medium">Industry</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.id} className="group hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link href={`/prospects/${r.id}`} className="flex items-center gap-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-semibold text-secondary-foreground">{initials(r.company_name)}</span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 font-medium group-hover:underline">{r.company_name}{r.is_synthetic ? <DemoTag /> : null}</span>
                          <span className="block truncate text-xs text-muted-foreground">{r.domain ?? [r.city, r.state].filter(Boolean).join(", ")}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-2 py-3"><TierBadge tier={r.tier as Tier} /></td>
                    <td className="max-w-72 px-4 py-3"><span className="line-clamp-2">{r.reason_to_buy}</span></td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">{windowLabel(r.contact_window_start, r.contact_window_end)}</td>
                    <td className="px-4 py-3">{r.top_contact_title ?? <span className="text-muted-foreground">Finding…</span>}</td>
                    <td className="px-4 py-3">{r.warm_path_count ? <span className="text-tide" title={r.warm_path_explanation ?? ""}>Yes · {r.warm_path_count}</span> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.industry ?? r.naics_title ?? "—"}</td>
                    <td className="px-4 py-3 capitalize">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 ? (
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Page {page} of {pages}</span>
            <div className="flex gap-2">
              {page > 1 ? <Link className="rounded-md border px-3 py-1.5 hover:bg-muted" href={href({ page: page - 1 })}>Previous</Link> : null}
              {page < pages ? <Link className="rounded-md border px-3 py-1.5 hover:bg-muted" href={href({ page: page + 1 })}>Next</Link> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

async function tabCounts(supabase: Awaited<ReturnType<typeof createClient>>, ws: string, uid: string) {
  const base = () => supabase.from("accounts").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
  const weekAgo = isoFromNow(-7);
  const [all, fresh, s, mine, watching] = await Promise.all([
    base().eq("research_status", "qualified"),
    base().eq("research_status", "qualified").gte("qualified_at", weekAgo),
    base().eq("research_status", "qualified").eq("tier", "S"),
    base().eq("research_status", "qualified").eq("owner_id", uid),
    base(),
  ]);
  return { all: all.count ?? 0, new: fresh.count ?? 0, s: s.count ?? 0, mine: mine.count ?? 0, watching: watching.count ?? 0 };
}
