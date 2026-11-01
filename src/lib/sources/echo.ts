import type { Connector, RawRecord } from "./types";
import { str } from "./types";

// EPA ECHO air facilities (ICIS-Air), public domain, no key. A manufacturing
// facility whose air-program status is "Planned" (PLN) or "Under
// Construction" (CNS) is a new plant on the way — it needs an air permit
// before production equipment that emits can be installed.
//
// ECHO publishes no date for these statuses, so the record is dated the day
// Tidemark first observes it and the signal says so ("observed"). When a
// facility later moves from Planned to Under Construction, that is a new,
// separately dated record (external_id includes the status).
//
// API: air_rest_services.get_facilities (returns a QueryID) → get_qid pages.

const BASE = "https://echodata.epa.gov/echo";
const STATUSES = [
  { code: "PLN", label: "Planned", type: "epa_air_facility_planned", strength: 60 },
  { code: "CNS", label: "Under construction", type: "epa_air_facility_construction", strength: 65 },
] as const;
const NAICS_PREFIXES = ["31", "32", "33"];
// Page size is fixed by get_facilities' responseset; get_qid pages use the same size.
const PAGE = 500;

interface EchoFacility {
  AIRName: string | null;
  SourceID: string;
  AIRStreet: string | null;
  AIRCity: string | null;
  AIRState: string | null;
  AIRZip: string | null;
  RegistryID: string | null;
  AIRNAICS: string | null;
  AIRNAICSDescs: string | null;
  AIRStatus: string | null;
  AIRPrograms: string | null;
  AIRUniverse: string | null;
  FacLat: string | null;
  FacLong: string | null;
}

async function echoJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`EPA ECHO ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { Results?: T & { Error?: { ErrorMessage?: string } } };
  if (!body.Results) throw new Error("EPA ECHO: unexpected response");
  if (body.Results.Error?.ErrorMessage) throw new Error(`EPA ECHO: ${body.Results.Error.ErrorMessage}`);
  return body.Results;
}

export const epaAirFacilities: Connector = {
  id: "epa.air_new_facilities",
  source: "epa",
  dataset: "echo_air_status",
  label: "New plants in EPA air data",
  description: "Manufacturing facilities listed as planned or under construction in EPA ICIS-Air (ECHO).",
  category: "building",
  defaultLookbackDays: 3650, // status-based, not date-based
  schedule: "weekly",
  disabledReason: () => null,

  async fetch(ctx) {
    const today = new Date().toISOString().slice(0, 10);
    const records: RawRecord[] = [];
    for (const status of STATUSES) {
      for (const naics of NAICS_PREFIXES) {
        const q = await echoJson<{ QueryID: string; QueryRows: string }>(
          `${BASE}/air_rest_services.get_facilities?output=JSON&p_ncs=${naics}&p_opst=${status.code}&responseset=${PAGE}`,
        );
        const rows = Number(q.QueryRows ?? 0);
        ctx.log(`${status.label} · NAICS ${naics}: ${rows} facilities`);
        for (let page = 1; (page - 1) * PAGE < rows && records.length < ctx.limit; page++) {
          const r = await echoJson<{ Facilities?: EchoFacility[] }>(
            `${BASE}/air_rest_services.get_qid?output=JSON&qid=${q.QueryID}&pageno=${page}`,
          );
          for (const f of r.Facilities ?? []) {
            const facility = str(f.AIRName);
            if (!facility) continue;
            // "AEC VIRGINIA LLC - BOYKINS PLANT" → company "AEC VIRGINIA LLC" (plant name kept in raw)
            const name = facility.split(/\s+[-–]\s+/)[0].replace(/\s+(PLANT|FACILITY|MILL|SITE)(\s+#?\d+)?$/i, "").trim() || facility;
            records.push({
              source: "epa",
              dataset: "echo_air_status",
              external_id: `${f.SourceID}:${status.code}`,
              record_type: status.type,
              occurred_on: today,
              entity_name: name,
              entity_street: str(f.AIRStreet),
              entity_city: str(f.AIRCity),
              entity_state: str(f.AIRState),
              entity_postal_code: str(f.AIRZip),
              entity_identifiers: f.RegistryID ? { frs: f.RegistryID } : {},
              url: f.RegistryID ? `https://echo.epa.gov/detailed-facility-report?fid=${f.RegistryID}` : null,
              raw: { ...f, _status: status.code, _observed_on: today },
            });
          }
        }
      }
    }
    return { records: records.slice(0, ctx.limit) };
  },

  toSignals(rec) {
    if (!rec.occurred_on) return [];
    const f = rec.raw as unknown as EchoFacility & { _status: "PLN" | "CNS"; _observed_on: string };
    const status = STATUSES.find((s) => s.code === f._status) ?? STATUSES[0];
    const industry = f.AIRNAICSDescs?.split(",")[0]?.replace(/^\d+:\s*/, "") ?? null;
    return [{
      category: "building",
      signal_type: status.type,
      title: status.code === "CNS" ? "New plant under construction (EPA air permit data)" : "New plant planned (EPA air permit data)",
      detail: `EPA ICIS-Air lists this facility as "${status.label}"${industry ? ` — ${industry.toLowerCase()}` : ""}${f.AIRPrograms ? ` · programs: ${f.AIRPrograms}` : ""}. Status observed ${f._observed_on}; EPA publishes no status date.`,
      occurred_on: rec.occurred_on,
      location: [f.AIRStreet, f.AIRCity, f.AIRState].filter(Boolean).join(", "),
      source_url: rec.url ?? null,
      attributes: { frs_registry_id: f.RegistryID, naics: f.AIRNAICS, programs: f.AIRPrograms, classification: f.AIRUniverse },
      strength: status.strength,
    }];
  },
};
