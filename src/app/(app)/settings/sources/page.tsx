import type { Metadata } from "next";
import { requireWorkspace, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CONNECTORS } from "@/lib/sources";
import { contactProviderStatus } from "@/lib/pipeline/contacts";
import { embeddingsEnabled } from "@/lib/knowledge/embed";
import { ago } from "@/lib/format";
import { CategoryChip } from "@/components/tm/badges";
import { RunSourceButton, DemoDataButton } from "./client";

export const metadata: Metadata = { title: "Data sources" };

const PROVIDER_NOTE: Record<string, string> = {
  pdl: "People Data Labs — licensed for use inside products on its Enterprise tier. Default provider.",
  hunter: "Hunter — domain email search + verification. Confirm product-use terms before relying on it.",
  apollo: "Apollo — licensed for internal use only. Enable only with a written agreement (CONTACTS_ALLOW_APOLLO=true).",
};

export default async function SourcesPage() {
  const ctx = await requireWorkspace();
  const supabase = await createClient();
  const { data: runs } = await supabase.from("ingestion_runs").select("source, dataset, status, started_at, finished_at, stats, error").order("started_at", { ascending: false }).limit(200);
  const latest = new Map<string, NonNullable<typeof runs>[number]>();
  for (const r of runs ?? []) { const k = `${r.source}/${r.dataset}`; if (!latest.has(k)) latest.set(k, r); }
  const admin = isAdmin(ctx.role);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="font-semibold">Public records</h2>
        <p className="mt-1 text-sm text-muted-foreground">Dated records Tidemark watches. Shared across workspaces; refreshed on a schedule.</p>
        <div className="mt-4 overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="px-4 py-2.5 font-medium">Source</th><th className="px-4 py-2.5 font-medium">Signal</th><th className="px-4 py-2.5 font-medium">Schedule</th><th className="px-4 py-2.5 font-medium">Last run</th><th /></tr>
            </thead>
            <tbody className="divide-y">
              {CONNECTORS.filter((c) => c.id !== "seed.demo").map((c) => {
                const run = latest.get(`${c.source}/${c.dataset}`);
                const disabled = c.disabledReason();
                const stats = (run?.stats ?? {}) as { fetched?: number; signals?: number };
                return (
                  <tr key={c.id} className="align-top">
                    <td className="px-4 py-3"><div className="font-medium">{c.label}</div><div className="text-xs text-muted-foreground">{c.description}</div>{disabled ? <div className="mt-1 text-xs text-signal-foreground">{disabled}</div> : null}</td>
                    <td className="px-4 py-3"><CategoryChip category={c.category} /></td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{c.schedule}</td>
                    <td className="px-4 py-3 text-xs">
                      {run ? (
                        <>
                          <div className={run.status === "failed" ? "text-destructive" : ""}>{run.status} · {ago(run.finished_at ?? run.started_at)}</div>
                          {run.status === "succeeded" ? <div className="text-muted-foreground">{stats.fetched ?? 0} fetched · {stats.signals ?? 0} signals</div> : null}
                          {run.error ? <div className="max-w-xs truncate text-destructive" title={run.error}>{run.error}</div> : null}
                        </>
                      ) : <span className="text-muted-foreground">Never</span>}
                    </td>
                    <td className="px-4 py-3 text-right">{admin && !disabled ? <RunSourceButton id={c.id} /> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Customs shipments and supplier switches need a licensed bill-of-lading provider (e.g. ImportGenius, Panjiva, Descartes Datamyne). Until one is connected, those signal types appear only in demo data.</p>
      </section>

      <section>
        <h2 className="font-semibold">Contact data</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {contactProviderStatus().map((p) => (
            <li key={p.id} className="flex items-start gap-2 rounded-lg border bg-card px-3 py-2">
              <span className={p.enabled ? "text-tier-s" : "text-muted-foreground"}>{p.enabled ? "On" : "Off"}</span>
              <span className="text-muted-foreground">{PROVIDER_NOTE[p.id]}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">Emails are verified before they show as verified (ZeroBounce, else Hunter). Knowledge search: {embeddingsEnabled() ? "full-text + embeddings (Voyage)" : "full-text"}.</p>
      </section>

      <section>
        <h2 className="font-semibold">Demo data</h2>
        <p className="mt-1 text-sm text-muted-foreground">120 fictional manufacturers with realistic timelines — some that add up to a reason to buy, some that don&apos;t. Clearly marked “Demo” everywhere, with reserved .example domains so nothing can be emailed.</p>
        <div className="mt-3"><DemoDataButton /></div>
      </section>
    </div>
  );
}
