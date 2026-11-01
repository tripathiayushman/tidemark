import type { Metadata } from "next";
import Link from "next/link";
import { CheckSquare } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/tm/page-header";
import { shortDate } from "@/lib/format";
import { TaskRowActions, NewTaskButton } from "./client";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage(props: PageProps<"/tasks">) {
  const ctx = await requireWorkspace();
  const sp = await props.searchParams;
  const view = sp.view === "all" ? "all" : sp.view === "done" ? "done" : "mine";
  const supabase = await createClient();
  let q = supabase
    .from("tasks")
    .select("id, title, description, due_on, status, kind, source, account_id, assignee_id, accounts(reason_to_buy, companies(name))")
    .eq("workspace_id", ctx.workspace.id)
    .order("due_on", { ascending: true, nullsFirst: false })
    .limit(200);
  if (view === "done") q = q.eq("status", "done");
  else q = q.eq("status", "open");
  if (view === "mine") q = q.or(`assignee_id.eq.${ctx.user.id},assignee_id.is.null`);
  const { data: tasks } = await q;
  const today = new Date().toISOString().slice(0, 10);

  type Row = { id: string; title: string; description: string | null; due_on: string | null; status: string; kind: string; source: string; account_id: string | null; accounts: { reason_to_buy: string | null; companies: { name: string } } | null };
  const rows = (tasks ?? []) as unknown as Row[];
  const groups = view === "done" ? [{ label: "Completed", items: rows }] : [
    { label: "Overdue", items: rows.filter((t) => t.due_on && t.due_on < today) },
    { label: "Today", items: rows.filter((t) => t.due_on === today) },
    { label: "Upcoming", items: rows.filter((t) => t.due_on && t.due_on > today) },
    { label: "No date", items: rows.filter((t) => !t.due_on) },
  ];

  return (
    <div>
      <PageHeader title="Tasks" description="Reach-outs Tidemark suggests when a prospect qualifies, plus your own." actions={<NewTaskButton />} />
      <div className="px-6 pt-4">
        <nav className="flex gap-1 border-b">
          {[["mine", "Mine"], ["all", "Everyone"], ["done", "Done"]].map(([k, l]) => (
            <Link key={k} href={`/tasks?view=${k}`} className={cn("-mb-px border-b-2 px-3 py-2 text-sm", view === k ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{l}</Link>
          ))}
        </nav>
      </div>
      <div className="space-y-8 p-6">
        {!rows.length ? <EmptyState icon={<CheckSquare className="size-6" />} title="Nothing here">Tasks appear when prospects qualify or replies come in.</EmptyState> : null}
        {groups.filter((g) => g.items.length).map((g) => (
          <section key={g.label}>
            <h2 className={cn("mb-2 text-sm font-semibold", g.label === "Overdue" ? "text-destructive" : "text-muted-foreground")}>{g.label} · {g.items.length}</h2>
            <ul className="divide-y rounded-xl border bg-card">
              {g.items.map((t) => (
                <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                  <TaskRowActions id={t.id} done={t.status === "done"} />
                  <div className="min-w-0 flex-1">
                    <div className={cn("text-sm font-medium", t.status === "done" && "text-muted-foreground line-through")}>{t.title}</div>
                    {t.accounts ? (
                      <Link href={`/prospects/${t.account_id}`} className="text-xs text-muted-foreground hover:underline">{t.accounts.companies.name}{t.accounts.reason_to_buy ? ` · ${t.accounts.reason_to_buy}` : ""}</Link>
                    ) : null}
                    {t.description ? <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{t.description}</p> : null}
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <div>{t.due_on ? shortDate(t.due_on) : ""}</div>
                    {t.source === "system" ? <div className="text-tide">Suggested</div> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
