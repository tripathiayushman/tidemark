import type { SupabaseClient } from "@supabase/supabase-js";
import { getConnector } from "@/lib/sources";
import { fetchFleetSizes } from "@/lib/sources/fmcsa";
import type { RawRecord } from "@/lib/sources/types";
import { isoDaysAgo } from "./normalize";
import { resolvePendingRecords } from "./resolve";
import { enqueue } from "@/lib/jobs";

export interface IngestResult {
  connector: string;
  fetched: number;
  inserted: number;
  resolved: Awaited<ReturnType<typeof resolvePendingRecords>> | null;
  log: string[];
}

/** Runs one connector end to end: fetch → store raw → resolve → signals. */
export async function runConnector(
  db: SupabaseClient,
  connectorId: string,
  opts: { since?: string; limit?: number; resolveBudgetMs?: number } = {},
): Promise<IngestResult> {
  const connector = getConnector(connectorId);
  if (!connector) throw new Error(`Unknown connector ${connectorId}`);
  const disabled = connector.disabledReason();
  if (disabled) throw new Error(`${connector.label} is disabled: ${disabled}`);

  const log: string[] = [];
  const say = (m: string) => {
    log.push(m);
    console.log(`[ingest:${connector.id}] ${m}`);
  };

  // Resume from the last successful run (with a 7-day overlap for late data).
  const { data: last } = await db
    .from("ingestion_runs")
    .select("finished_at, cursor")
    .eq("source", connector.source)
    .eq("dataset", connector.dataset)
    .eq("status", "succeeded")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const since =
    opts.since ??
    (last?.finished_at
      ? isoDaysAgo(7, new Date(last.finished_at))
      : isoDaysAgo(connector.defaultLookbackDays));

  // Runs that never finished (process killed, function timed out) → failed.
  await db
    .from("ingestion_runs")
    .update({ status: "failed", finished_at: new Date().toISOString(), error: "Interrupted before finishing" })
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - 30 * 60_000).toISOString());

  const { data: run, error: runErr } = await db
    .from("ingestion_runs")
    .insert({ source: connector.source, dataset: connector.dataset, cursor: { since } })
    .select("id")
    .single();
  if (runErr) throw new Error(`ingestion_runs: ${runErr.message}`);

  try {
    say(`fetching since ${since}`);
    const result = await connector.fetch({ since, limit: opts.limit ?? 2000, cursor: (last?.cursor as Record<string, unknown>) ?? {}, log: say });
    const inserted = await storeRecords(db, result.records);
    say(`stored ${inserted} new of ${result.records.length} fetched`);

    // Resolve within a time budget; the rest continues in records.resolve jobs
    // so this also works inside short serverless invocations.
    const resolved = await resolvePendingRecords(db, { limit: 2000, budgetMs: opts.resolveBudgetMs ?? 25_000 });
    say(`resolved ${resolved.processed} (matched ${resolved.matched}, created ${resolved.created}, signals ${resolved.signals}); ${resolved.remaining} left`);
    if (resolved.remaining > 0) {
      await enqueue("records.resolve", { limit: 500 }, { dedupeKey: "records.resolve", priority: 60 });
    }

    if (result.metrics?.length) await storeFleetMetrics(db, result.metrics);

    await db
      .from("ingestion_runs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        cursor: { since, ...(result.cursor ?? {}) },
        stats: { fetched: result.records.length, inserted, ...resolved },
      })
      .eq("id", run.id);
    return { connector: connector.id, fetched: result.records.length, inserted, resolved, log };
  } catch (e) {
    await db
      .from("ingestion_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error: (e as Error).message.slice(0, 2000) })
      .eq("id", run.id);
    throw e;
  }
}

export async function storeRecords(db: SupabaseClient, records: RawRecord[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500).map((r) => ({
      source: r.source,
      dataset: r.dataset,
      external_id: r.external_id,
      record_type: r.record_type,
      occurred_on: r.occurred_on,
      entity_name: r.entity_name,
      entity_street: r.entity_street ?? null,
      entity_city: r.entity_city ?? null,
      entity_state: r.entity_state ?? null,
      entity_postal_code: r.entity_postal_code ?? null,
      entity_identifiers: r.entity_identifiers ?? {},
      amount: r.amount ?? null,
      url: r.url ?? null,
      raw: r.raw,
      is_synthetic: r.is_synthetic ?? false,
    }));
    const { data, error } = await db
      .from("source_records")
      .upsert(chunk, { onConflict: "source,dataset,external_id", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`store records: ${error.message}`);
    inserted += data?.length ?? 0;
  }
  return inserted;
}

async function storeFleetMetrics(db: SupabaseClient, metrics: { usdot: string; metric: string; value: number; observed_on: string }[]) {
  const usdots = [...new Set(metrics.map((m) => m.usdot))];
  for (let i = 0; i < usdots.length; i += 200) {
    const { data: companies } = await db.from("companies").select("id, usdot_number").in("usdot_number", usdots.slice(i, i + 200));
    const byDot = new Map((companies ?? []).map((c) => [c.usdot_number as string, c.id as string]));
    const rows = metrics
      .filter((m) => byDot.has(m.usdot))
      .map((m) => ({ company_id: byDot.get(m.usdot)!, metric: m.metric, value: m.value, observed_on: m.observed_on, source: "fmcsa" }));
    if (rows.length) await db.from("company_metrics").upsert(rows, { onConflict: "company_id,metric,observed_on" });
  }
}

/**
 * Re-checks fleet size for watched companies with a USDOT number and emits
 * fleet_growth records when power units rose ≥20% and by ≥2 since the last
 * snapshot.
 */
export async function refreshFleets(db: SupabaseClient): Promise<{ checked: number; growth: number }> {
  const { data: watched } = await db
    .from("accounts")
    .select("company_id, companies!inner(id, usdot_number, name)")
    .not("companies.usdot_number", "is", null)
    .limit(2000);
  type Row = { company_id: string; companies: { id: string; usdot_number: string; name: string } };
  const companies = new Map<string, Row["companies"]>();
  for (const r of (watched ?? []) as unknown as Row[]) companies.set(r.companies.usdot_number, r.companies);
  if (companies.size === 0) return { checked: 0, growth: 0 };

  const current = await fetchFleetSizes([...companies.keys()]);
  const today = new Date().toISOString().slice(0, 10);
  const growthRecords: RawRecord[] = [];
  for (const [dot, row] of Object.entries(current)) {
    const company = companies.get(dot);
    if (!company) continue;
    const units = Number(row.power_units ?? 0);
    const { data: prev } = await db
      .from("company_metrics")
      .select("value, observed_on")
      .eq("company_id", company.id)
      .eq("metric", "power_units")
      .lt("observed_on", today)
      .order("observed_on", { ascending: false })
      .limit(1)
      .maybeSingle();
    await db.from("company_metrics").upsert(
      { company_id: company.id, metric: "power_units", value: units, observed_on: today, source: "fmcsa" },
      { onConflict: "company_id,metric,observed_on" },
    );
    const before = prev ? Number(prev.value) : null;
    if (before != null && units - before >= 2 && units >= before * 1.2) {
      growthRecords.push({
        source: "fmcsa",
        dataset: "carrier_census",
        external_id: `growth:${dot}:${today}`,
        record_type: "fleet_growth",
        occurred_on: today,
        entity_name: row.legal_name ?? company.name,
        entity_identifiers: { usdot: dot },
        url: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`,
        raw: { ...row, _previous_units: String(before), _previous_on: prev!.observed_on },
      });
    }
  }
  if (growthRecords.length) {
    await storeRecords(db, growthRecords);
    await resolvePendingRecords(db, { limit: growthRecords.length + 10, budgetMs: 20_000 });
  }
  return { checked: Object.keys(current).length, growth: growthRecords.length };
}
