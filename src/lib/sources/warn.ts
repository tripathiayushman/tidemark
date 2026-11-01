import Papa from "papaparse";
import type { Connector, RawRecord } from "./types";
import { num, str } from "./types";
import { toIsoDate } from "@/lib/pipeline/normalize";

// WARN Act layoff notices via WARN Feed (CC BY 4.0, 47 states + DC, rebuilt
// daily). Used as a NEGATIVE signal: a large layoff lowers a company's
// activity score. matchOnly — notices only attach to companies already in
// the graph; they never create new ones.
//
// Attribution (required by CC BY 4.0): "WARN Feed" —
// https://github.com/APVentureEngine/warn-act-notices

const LATEST = "https://raw.githubusercontent.com/APVentureEngine/warn-act-notices/main/data/latest.csv";
const ATTRIBUTION = "https://github.com/APVentureEngine/warn-act-notices";

export const warnNotices: Connector = {
  id: "warn.feed",
  source: "warn",
  dataset: "warn_feed",
  label: "WARN layoff notices",
  description: "Layoff and closure notices (WARN Feed, CC BY 4.0) — lowers scores for companies already watched.",
  category: "operations",
  defaultLookbackDays: 120,
  schedule: "daily",
  matchOnly: true,
  disabledReason: () => null,

  async fetch(ctx) {
    const res = await fetch(LATEST, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`WARN Feed ${res.status}`);
    const parsed = Papa.parse<Record<string, string>>(await res.text(), { header: true, skipEmptyLines: true });
    const records: RawRecord[] = [];
    for (const r of parsed.data) {
      const notice = toIsoDate(r.notice_date);
      if (!notice || notice < ctx.since) continue;
      const company = str(r.company_canonical) ?? str(r.company);
      if (!company) continue;
      records.push({
        source: "warn",
        dataset: "warn_feed",
        external_id: String(r.id),
        record_type: "warn_notice",
        occurred_on: notice,
        entity_name: company,
        entity_city: str(r.location),
        entity_state: str(r.state),
        url: ATTRIBUTION,
        raw: { employees: num(r.employees_affected), notice_type: str(r.notice_type), effective: str(r.effective_date), dba: str(r.company_dba) },
      });
      if (records.length >= ctx.limit) break;
    }
    ctx.log(`${parsed.data.length} notices in feed, ${records.length} since ${ctx.since}`);
    return { records };
  },

  toSignals(rec) {
    if (!rec.occurred_on) return [];
    const r = rec.raw as { employees: number | null; notice_type: string | null; effective: string | null };
    const n = r.employees ?? 0;
    return [{
      category: "operations",
      signal_type: "warn_notice",
      title: `WARN notice: ${n ? `${n} jobs affected` : "layoff filed"}`,
      detail: `${r.notice_type ?? "Layoff notice"}${r.effective ? `, effective ${r.effective}` : ""} · Source: WARN Feed (CC BY 4.0)`,
      occurred_on: rec.occurred_on,
      quantity: n || null,
      unit: n ? "employees" : null,
      location: [rec.entity_city, rec.entity_state].filter(Boolean).join(", "),
      source_url: rec.url ?? null,
      attributes: { notice_type: r.notice_type },
      strength: n >= 250 ? 70 : n >= 100 ? 55 : 40,
    }];
  },
};
