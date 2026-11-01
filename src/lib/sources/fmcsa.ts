import type { Connector, RawRecord } from "./types";
import { MANUFACTURING_NAME_HINTS, num, str } from "./types";
import { toIsoDate } from "@/lib/pipeline/normalize";

// FMCSA Motor Carrier Census (data.transportation.gov, Socrata, no key).
// Manufacturers that haul their own goods register as "PRIVATE PROPERTY"
// carriers. Two signals:
//   * new_registration — a new USDOT number (new operation / new state)
//   * fleet_growth     — power units up ≥20% (and ≥2) since our last snapshot
// Fleet snapshots are written to company_metrics by the ingest runner.

const BASE = "https://data.transportation.gov/resource/az4n-8mr2.json";

export const fmcsaCarriers: Connector = {
  id: "fmcsa.carriers",
  source: "fmcsa",
  dataset: "carrier_census",
  label: "Fleet registrations (FMCSA)",
  description: "New private-fleet USDOT registrations by manufacturers, plus fleet-size changes.",
  category: "operations",
  defaultLookbackDays: 60,
  schedule: "daily",
  disabledReason: () => null,

  async fetch(ctx) {
    const since = ctx.since.replace(/-/g, "");
    const records: RawRecord[] = [];
    const metrics: { usdot: string; metric: string; value: number; observed_on: string }[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const pageSize = 1000;
    for (let offset = 0; records.length < ctx.limit; offset += pageSize) {
      const params = new URLSearchParams({
        $where: `add_date >= '${since}' AND classdef like '%PRIVATE PROPERTY%' AND power_units >= '2'`,
        $order: "add_date DESC",
        $limit: String(pageSize),
        $offset: String(offset),
      });
      const res = await fetch(`${BASE}?${params}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`FMCSA ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const rows = (await res.json()) as Record<string, string>[];
      for (const r of rows) {
        const name = str(r.legal_name);
        if (!name || !MANUFACTURING_NAME_HINTS.test(name.toUpperCase())) continue;
        const units = num(r.power_units) ?? 0;
        records.push({
          source: "fmcsa",
          dataset: "carrier_census",
          external_id: `new:${r.dot_number}`,
          record_type: "new_registration",
          occurred_on: toIsoDate(r.add_date),
          entity_name: name,
          entity_street: str(r.phy_street),
          entity_city: str(r.phy_city),
          entity_state: str(r.phy_state),
          entity_postal_code: str(r.phy_zip),
          entity_identifiers: { usdot: r.dot_number, ...(r.dun_bradstreet_no ? { duns: r.dun_bradstreet_no } : {}) },
          amount: null,
          url: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${r.dot_number}`,
          raw: r,
        });
        metrics.push({ usdot: r.dot_number, metric: "power_units", value: units, observed_on: today });
      }
      ctx.log(`offset ${offset}: ${rows.length} carriers, ${records.length} manufacturer fleets`);
      if (rows.length < pageSize) break;
    }
    return { records: records.slice(0, ctx.limit), metrics };
  },

  toSignals(rec) {
    if (!rec.occurred_on) return [];
    const r = rec.raw as Record<string, string>;
    if (rec.record_type === "fleet_growth") {
      const from = num(r._previous_units) ?? 0;
      const to = num(r.power_units) ?? 0;
      return [{
        category: "operations",
        signal_type: "fleet_growth",
        title: `Fleet grew from ${from} to ${to} trucks`,
        detail: `Power units on USDOT ${r.dot_number} rose ${Math.round(((to - from) / Math.max(from, 1)) * 100)}%`,
        occurred_on: rec.occurred_on,
        quantity: to,
        unit: "power units",
        location: [r.phy_city, r.phy_state].filter(Boolean).join(", "),
        source_url: rec.url ?? null,
        attributes: { from, to },
        strength: 55,
      }];
    }
    const units = num(r.power_units) ?? 0;
    return [{
      category: "operations",
      signal_type: "new_registration",
      title: `New USDOT registration, ${units} power units`,
      detail: `Private fleet registered in ${[r.phy_city, r.phy_state].filter(Boolean).join(", ")}`,
      occurred_on: rec.occurred_on,
      quantity: units,
      unit: "power units",
      location: [r.phy_city, r.phy_state].filter(Boolean).join(", "),
      source_url: rec.url ?? null,
      attributes: { usdot: r.dot_number, drivers: num(r.total_drivers ?? r.driver_inter_total) },
      strength: units >= 10 ? 50 : 35,
    }];
  },
};

/**
 * Fleet refresh for companies we already know by USDOT number. Returns
 * current power units per USDOT (the ingest runner compares with the last
 * snapshot and emits fleet_growth records).
 */
export async function fetchFleetSizes(usdots: string[]): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (let i = 0; i < usdots.length; i += 100) {
    const batch = usdots.slice(i, i + 100).map((d) => `'${d.replace(/\D/g, "")}'`).join(",");
    const params = new URLSearchParams({ $where: `dot_number in (${batch})`, $limit: "1000" });
    const res = await fetch(`${BASE}?${params}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`FMCSA ${res.status}`);
    for (const r of (await res.json()) as Record<string, string>[]) out[r.dot_number] = r;
  }
  return out;
}
