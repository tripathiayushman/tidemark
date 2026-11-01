import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Radar } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, Section, EmptyState } from "@/components/tm/page-header";
import { CategoryChip, DemoTag, TierBadge } from "@/components/tm/badges";
import { dateFromNow, daysLeft, isoFromNow, shortDate, windowLabel } from "@/lib/format";
import type { SignalCategory, Tier } from "@/lib/types";
import { AutoRefresh } from "@/components/tm/auto-refresh";

export const metadata: Metadata = { title: "Home" };

interface Stats {
  watched: number; researching: number; qualified: number; new_this_week: number;
  windows_closing: number; open_tasks: number; with_warm_path: number; tier_counts: Partial<Record<Tier, number>>;
}

export default async function HomePage() {
  const ctx = await requireWorkspace();
  const supabase = await createClient();
  const ws = ctx.workspace.id;
  const weekAgo = isoFromNow(-7);
  const in14 = dateFromNow(14);

  const [{ data: stats }, { data: fresh }, { data: closing }, { data: tasks }, { data: feed }, { count: queuedJobs }] = await Promise.all([
    supabase.rpc("workspace_stats", { p_workspace_id: ws }),
    supabase.from("prospect_rows").select("id, company_name, is_synthetic, tier, reason_to_buy, contact_window_start, contact_window_end, top_contact_title")
      .eq("workspace_id", ws).eq("research_status", "qualified").gte("qualified_at", weekAgo).order("score", { ascending: false }).limit(6),
    supabase.from("prospect_rows").select("id, company_name, is_synthetic, tier, reason_to_buy, contact_window_end, warm_path_count")
      .eq("workspace_id", ws).eq("research_status", "qualified").gte("contact_window_end", dateFromNow()).lte("contact_window_end", in14).order("contact_window_end").limit(6),
    supabase.from("tasks").select("id, title, due_on, account_id, accounts(companies(name))").eq("workspace_id", ws).eq("status", "open").order("due_on", { ascending: true, nullsFirst: false }).limit(6),
    supabase.from("accounts").select("id, companies!inner(name, is_synthetic, signals(id, title, category, occurred_on, created_at))")
      .eq("workspace_id", ws).order("last_signal_on", { ascending: false, nullsFirst: false }).limit(25),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("status", ["queued", "running"]),
  ]);

  const s = (stats ?? {}) as Stats;
  type FeedRow = { id: string; companies: { name: string; is_synthetic: boolean; signals: { id: string; title: string; category: SignalCategory; occurred_on: string; created_at: string }[] } };
  const events = ((feed ?? []) as unknown as FeedRow[])
    .flatMap((a) => a.companies.signals.map((sig) => ({ ...sig, accountId: a.id, company: a.companies.name, demo: a.companies.is_synthetic })))
    .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on))
    .slice(0, 12);

  const tiles = [
    { label: "Prospects", value: s.qualified ?? 0, href: "/prospects" },
    { label: "New this week", value: s.new_this_week ?? 0, href: "/prospects?tab=new" },
    { label: "Windows closing (14d)", value: s.windows_closing ?? 0, href: "/prospects?sort=window" },
    { label: "Open tasks", value: s.open_tasks ?? 0, href: "/tasks" },
    { label: "Companies watched", value: s.watched ?? 0, href: "/prospects?tab=watching" },
  ];

  return (
    <div>
      <AutoRefresh active={(queuedJobs ?? 0) > 0} />
      <PageHeader
        title={`Good ${greeting()}, ${ctx.user.fullName?.split(" ")[0] ?? "there"}`}
        description={(queuedJobs ?? 0) > 0 ? `Researching — ${queuedJobs} job${queuedJobs === 1 ? "" : "s"} in progress. This page updates as prospects qualify.` : "Here's who has a reason to buy right now."}
      />
      <div className="space-y-8 p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {tiles.map((t) => (
            <Link key={t.label} href={t.href} className="rounded-xl border bg-card p-4 transition-colors hover:border-tide/50">
              <div className="text-2xl font-semibold tabular-nums">{t.value.toLocaleString()}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.label}</div>
            </Link>
          ))}
        </div>

        {(s.watched ?? 0) === 0 ? (
          <EmptyState icon={<Radar className="size-6" />} title="Nothing on the watchlist yet">
            Public records are loading and being matched against your ICP. Check <Link className="underline" href="/settings/icp">your ICP</Link>, or add demo data from <Link className="underline" href="/settings/sources">Data sources</Link>.
          </EmptyState>
        ) : (
          <div className="grid gap-8 lg:grid-cols-3">
            <div className="space-y-8 lg:col-span-2">
              <Section title="New this week" action={<Link href="/prospects?tab=new" className="text-xs text-muted-foreground hover:text-foreground">See all <ArrowRight className="inline size-3" /></Link>}>
                {fresh?.length ? (
                  <ul className="divide-y rounded-xl border bg-card">
                    {fresh.map((p) => (
                      <li key={p.id}>
                        <Link href={`/prospects/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
                          <TierBadge tier={p.tier as Tier} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 font-medium">{p.company_name}{p.is_synthetic ? <DemoTag /> : null}</div>
                            <div className="truncate text-sm text-muted-foreground">{p.reason_to_buy}</div>
                          </div>
                          <div className="hidden text-right text-xs text-muted-foreground sm:block">
                            <div>{windowLabel(p.contact_window_start, p.contact_window_end)}</div>
                            <div>{p.top_contact_title ?? ""}</div>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No new prospects this week yet.</p>}
              </Section>

              <Section title="Watching public sources">
                <ul className="space-y-1">
                  {events.map((e) => (
                    <li key={e.id}>
                      <Link href={`/prospects/${e.accountId}`} className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-muted/50">
                        <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">{shortDate(e.occurred_on)}</span>
                        <CategoryChip category={e.category} className="hidden sm:inline-flex" />
                        <span className="min-w-0 flex-1 truncate"><span className="font-medium">{e.company}</span> · {e.title}</span>
                        {e.demo ? <DemoTag /> : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            </div>

            <div className="space-y-8">
              <Section title="Windows closing">
                {closing?.length ? (
                  <ul className="space-y-2">
                    {closing.map((p) => {
                      const left = daysLeft(p.contact_window_end);
                      return (
                        <li key={p.id}>
                          <Link href={`/prospects/${p.id}`} className="block rounded-xl border bg-card p-3 hover:border-tide/50">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-medium">{p.company_name}</span>
                              <span className={left != null && left <= 5 ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>{left}d left</span>
                            </div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">{p.reason_to_buy}</div>
                            {p.warm_path_count ? <div className="mt-1 text-xs text-tide">Warm intro available</div> : null}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No windows close in the next two weeks.</p>}
              </Section>

              <Section title="Your tasks" action={<Link href="/tasks" className="text-xs text-muted-foreground hover:text-foreground">All tasks</Link>}>
                {tasks?.length ? (
                  <ul className="space-y-1.5 text-sm">
                    {tasks.map((t) => (
                      <li key={t.id} className="flex items-start justify-between gap-2">
                        <Link href={t.account_id ? `/prospects/${t.account_id}` : "/tasks"} className="min-w-0 hover:underline">
                          <span className="block truncate">{t.title}</span>
                          <span className="text-xs text-muted-foreground">{(t.accounts as unknown as { companies: { name: string } } | null)?.companies?.name}</span>
                        </Link>
                        <span className="shrink-0 text-xs text-muted-foreground">{t.due_on ? shortDate(t.due_on) : ""}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">You&apos;re all caught up.</p>}
              </Section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
