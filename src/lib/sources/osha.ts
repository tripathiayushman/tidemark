import Papa from "papaparse";
import { Readable } from "node:stream";
import type { Connector, RawRecord, SignalDraft } from "./types";
import { num } from "./types";
import { optionalEnv } from "@/lib/env";

// OSHA ITA Form 300A establishment data (DOL public domain): the only free
// file with plant-level employee counts, NAICS, street address and EIN
// together. Used two ways:
//   1. Enrichment — fills employee_count / NAICS / EIN on companies we
//      already track (matchOnly: never creates companies), sharpening fit.
//   2. Growth — stores headcount per filing year in company_metrics and
//      emits a headcount_growth signal when a plant grows ≥15% and ≥25 people
//      year over year.
//
// Note: osha.gov rejects some non-US networks (CloudFront 403). The file URL
// can be overridden with OSHA_300A_CSV_URL (e.g. a mirrored copy).
// Column names follow OSHA's summary data dictionary; headers are matched
// case- and punctuation-insensitively in case they shift between years.

const DEFAULT_URL = "https://www.osha.gov/sites/default/largefiles/ITA_300A_Summary_Data_2025_through_08-31-2026.csv";

function pick(row: Record<string, string>, ...names: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const n of names) {
    const key = Object.keys(row).find((k) => norm(k) === norm(n));
    if (key && row[key] != null && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  return null;
}

/** Exported for tests: CSV row → raw record fields (null when not a manufacturer). */
export function mapOshaRow(row: Record<string, string>): Omit<RawRecord, "source" | "dataset" | "url"> | null {
  const naics = pick(row, "naics_code", "naics");
  if (!naics || !/^3[1-3]/.test(naics)) return null;
  const year = pick(row, "year_filing_for", "year");
  const estId = pick(row, "establishment_id", "id");
  const name = pick(row, "company_name") ?? pick(row, "establishment_name");
  if (!estId || !name || !year) return null;
  const ein = pick(row, "ein");
  return {
    external_id: `${estId}:${year}`,
    record_type: "osha_300a",
    occurred_on: `${year}-12-31`,
    entity_name: name,
    entity_street: pick(row, "street_address", "address"),
    entity_city: pick(row, "city"),
    entity_state: pick(row, "state"),
    entity_postal_code: pick(row, "zip_code", "zip"),
    entity_identifiers: ein && /^\d{9}$/.test(ein.replace(/\D/g, "")) ? { ein: ein.replace(/\D/g, "") } : {},
    raw: {
      establishment_id: estId,
      establishment_name: pick(row, "establishment_name"),
      naics,
      industry: pick(row, "industry_description"),
      employees: num(pick(row, "annual_average_employees")),
      hours: num(pick(row, "total_hours_worked")),
      year: Number(year),
    },
  };
}

export const osha300a: Connector = {
  id: "osha.ita_300a",
  source: "osha",
  dataset: "ita_300a",
  label: "Plant headcounts (OSHA 300A)",
  description: "Establishment employee counts, NAICS and EIN for tracked manufacturers; flags year-over-year headcount growth.",
  category: "operations",
  defaultLookbackDays: 3650,
  schedule: "weekly",
  matchOnly: true,
  disabledReason: () => null,

  async fetch(ctx) {
    const url = optionalEnv("OSHA_300A_CSV_URL") ?? DEFAULT_URL;
    ctx.log(`reading ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000), headers: { "User-Agent": "TidemarkBot/1.0 (+public data)" } });
    if (res.status === 403) throw new Error("osha.gov refused the request (403) — it blocks some non-US networks. Run from US hosting or set OSHA_300A_CSV_URL to a mirror.");
    if (!res.ok || !res.body) throw new Error(`OSHA 300A ${res.status}`);
    const records: RawRecord[] = [];
    let scanned = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream);
      Papa.parse<Record<string, string>>(stream as unknown as File, {
        header: true,
        skipEmptyLines: true,
        step: (result, parser) => {
          scanned++;
          const m = mapOshaRow(result.data);
          if (!m) return;
          records.push({ ...m, source: "osha", dataset: "ita_300a", url: "https://www.osha.gov/Establishment-Specific-Injury-and-Illness-Data" });
          if (records.length >= ctx.limit) parser.abort();
        },
        complete: () => resolve(),
        error: (err: Error) => reject(err),
      });
    });
    ctx.log(`scanned ${scanned} rows, kept ${records.length} manufacturing establishments`);
    return { records };
  },

  // The 300A row itself is not a buying signal; growth is computed in afterMatch.
  toSignals() {
    return [];
  },

  async afterMatch(db, rec, companyId): Promise<SignalDraft[]> {
    const r = rec.raw as { employees: number | null; naics: string; year: number; establishment_id: string };
    const ein = (rec.entity_identifiers ?? {}).ein;
    const { data: company } = await db.from("companies").select("employee_count, naics_code, ein").eq("id", companyId).single();
    const patch: Record<string, unknown> = {};
    if (r.employees && (!company?.employee_count || company.employee_count < r.employees)) patch.employee_count = r.employees;
    if (!company?.naics_code && r.naics) patch.naics_code = r.naics;
    if (!company?.ein && ein) patch.ein = ein;
    if (Object.keys(patch).length) await db.from("companies").update(patch).eq("id", companyId);
    if (!r.employees) return [];

    const observed = `${r.year}-12-31`;
    await db.from("company_metrics").upsert(
      { company_id: companyId, metric: `employees:${r.establishment_id}`, observed_on: observed, value: r.employees, source: "osha" },
      { onConflict: "company_id,metric,observed_on" },
    );
    const { data: prev } = await db
      .from("company_metrics")
      .select("value, observed_on")
      .eq("company_id", companyId)
      .eq("metric", `employees:${r.establishment_id}`)
      .lt("observed_on", observed)
      .order("observed_on", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!prev) return [];
    const before = Number(prev.value);
    if (r.employees - before < 25 || r.employees < before * 1.15) return [];
    return [{
      category: "operations",
      signal_type: "headcount_growth",
      title: `Plant headcount grew from ${before} to ${r.employees}`,
      detail: `OSHA Form 300A annual average employees, ${prev.observed_on.slice(0, 4)} → ${r.year}`,
      occurred_on: observed,
      quantity: r.employees,
      unit: "employees",
      location: [rec.entity_city, rec.entity_state].filter(Boolean).join(", "),
      source_url: rec.url ?? null,
      attributes: { from: before, to: r.employees, establishment_id: r.establishment_id },
      strength: r.employees >= before * 1.4 ? 60 : 50,
    }];
  },
};

