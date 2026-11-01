import type { Connector, RawRecord, SignalDraft } from "./types";
import { str } from "./types";
import { stateCode } from "@/lib/pipeline/normalize";

// Foreign-Trade Zones Board notices from the Federal Register API (public
// domain, no key). Each production authorization or subzone notice names the
// company, the exact site and the finished products — a new or expanded
// import-dependent production line. Low volume, high signal.
//
// Title shapes seen (segments separated by ";"):
//   FTZ 80; Authorization of Production Activity; StandardAero San Antonio; (Refurbished Engines); San Antonio, Texas
//   FTZ (FTZ) 17, Notification of Proposed Production Activity; Honeywell Aerospace US LLC; (Aircraft Components); Olathe, Kansas
//   Foreign-Trade Zone 222; Approval of Subzone Status; Vulcaflex Inc.; Auburn, Alabama
// Negative notices ("Not Authorized", "Withdrawal") and zone-level notices are skipped.

const API = "https://www.federalregister.gov/api/v1/documents.json";

const KINDS: { re: RegExp; type: string; category: SignalDraft["category"]; strength: number; label: string }[] = [
  { re: /notification of proposed production activity/i, type: "ftz_production_proposed", category: "equipment_supply", strength: 60, label: "FTZ production activity proposed" },
  { re: /authorization of (limited )?production activity/i, type: "ftz_production_authorized", category: "equipment_supply", strength: 65, label: "FTZ production activity authorized" },
  { re: /application for subzone expansion/i, type: "ftz_subzone_expansion", category: "building", strength: 60, label: "Applied to expand an FTZ subzone" },
  { re: /application for subzone/i, type: "ftz_subzone_application", category: "building", strength: 60, label: "Applied for FTZ subzone status" },
  { re: /approval of subzone status/i, type: "ftz_subzone_approved", category: "building", strength: 60, label: "FTZ subzone approved" },
];
const SKIP = /not authorized|withdrawal|termination|reorganization|grant of authority|board meeting|expansion of production authority denied/i;



export interface ParsedFtz {
  kind: (typeof KINDS)[number];
  company: string;
  products: string | null;
  city: string | null;
  state: string | null;
  location: string | null;
}

/** Exported for tests. */
export function parseFtzTitle(title: string): ParsedFtz | null {
  if (SKIP.test(title)) return null;
  const kind = KINDS.find((k) => k.re.test(title));
  if (!kind) return null;
  // split on ";" and on the "FTZ 17, Notification…" comma form
  const segs = title.split(";").flatMap((s) => (kind.re.test(s) && /foreign-trade zone/i.test(s) ? s.split(/,(?=\s*(?:notification|authorization|application|approval))/i) : [s])).map((s) => s.trim()).filter(Boolean);
  const kIdx = segs.findIndex((s) => kind.re.test(s));
  const rest = segs.slice(kIdx + 1).filter((s) => !/^foreign-trade zone/i.test(s));
  const company = rest.find((s) => !s.startsWith("("));
  if (!company) return null;
  const products = rest.find((s) => s.startsWith("("))?.replace(/^\(|\)$/g, "") ?? null;
  const location = rest[rest.length - 1] !== company && !rest[rest.length - 1].startsWith("(") ? rest[rest.length - 1] : null;
  let city: string | null = null;
  let state: string | null = null;
  if (location) {
    const parts = location.split(",").map((p) => p.trim());
    state = stateCode(parts[parts.length - 1]);
    city = parts.length > 1 ? parts[0].replace(/^and\s+/i, "") : null;
  }
  return { kind, company, products, city, state, location };
}

export const ftzNotices: Connector = {
  id: "federal_register.ftz",
  source: "federal_register",
  dataset: "ftz_notices",
  label: "Foreign-Trade Zone notices",
  description: "FTZ Board production authorizations and subzone filings — named company, site and products (Federal Register).",
  category: "equipment_supply",
  defaultLookbackDays: 365,
  schedule: "daily",
  disabledReason: () => null,

  async fetch(ctx) {
    const records: RawRecord[] = [];
    for (let page = 1; records.length < ctx.limit && page <= 20; page++) {
      const params = new URLSearchParams({ per_page: "100", order: "newest", page: String(page) });
      params.append("conditions[agencies][]", "foreign-trade-zones-board");
      params.append("conditions[publication_date][gte]", ctx.since);
      for (const f of ["title", "publication_date", "html_url", "document_number", "abstract"]) params.append("fields[]", f);
      const res = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Federal Register ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { results?: { title: string; publication_date: string; html_url: string; document_number: string; abstract: string | null }[]; total_pages?: number };
      for (const doc of body.results ?? []) {
        const p = parseFtzTitle(doc.title);
        if (!p) continue;
        records.push({
          source: "federal_register",
          dataset: "ftz_notices",
          external_id: doc.document_number,
          record_type: p.kind.type,
          occurred_on: doc.publication_date,
          entity_name: p.company,
          entity_city: p.city,
          entity_state: p.state,
          url: doc.html_url,
          raw: { title: doc.title, abstract: str(doc.abstract), products: p.products, location: p.location, kind: p.kind.type },
        });
      }
      ctx.log(`page ${page}: ${body.results?.length ?? 0} notices, ${records.length} company notices kept`);
      if (!body.total_pages || page >= body.total_pages) break;
    }
    return { records: records.slice(0, ctx.limit) };
  },

  toSignals(rec) {
    if (!rec.occurred_on) return [];
    const r = rec.raw as { products: string | null; location: string | null; kind: string };
    const kind = KINDS.find((k) => k.type === r.kind) ?? KINDS[1];
    return [{
      category: kind.category,
      signal_type: kind.type,
      title: `${kind.label}${r.products ? `: ${r.products.toLowerCase()}` : ""}`,
      detail: `Foreign-Trade Zones Board notice${r.location ? ` for the site in ${r.location}` : ""}. Production under FTZ procedures means imported components feeding a US line.`,
      occurred_on: rec.occurred_on,
      location: r.location,
      source_url: rec.url ?? null,
      attributes: { products: r.products },
      strength: kind.strength,
    }];
  },
};
