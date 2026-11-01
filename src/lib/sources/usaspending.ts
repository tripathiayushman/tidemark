import type { Connector, RawRecord } from "./types";
import { num, str } from "./types";
import { formatMoney } from "@/lib/pipeline/normalize";

// Federal contract awards to manufacturers (NAICS 31–33) from USASpending.gov.
// Public API, no key. Only new awards above $250K, which bring new work and
// new requirements ("Contracts" signals).

const ENDPOINT = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const FIELDS = [
  "Award ID", "Recipient Name", "Recipient UEI", "Award Amount", "Description",
  "Start Date", "Base Obligation Date", "Awarding Agency", "Awarding Sub Agency",
  "naics_code", "naics_description", "Place of Performance State Code",
  "Place of Performance Zip5", "Recipient Location",
];

interface AwardRow {
  "Award ID": string;
  "Recipient Name": string | null;
  "Recipient UEI": string | null;
  "Award Amount": number | null;
  Description: string | null;
  "Start Date": string | null;
  "Base Obligation Date": string | null;
  "Awarding Agency": string | null;
  "Awarding Sub Agency": string | null;
  naics_code: string | null;
  naics_description: string | null;
  "Place of Performance State Code": string | null;
  "Place of Performance Zip5": string | null;
  "Recipient Location": {
    address_line1?: string | null;
    city_name?: string | null;
    state_code?: string | null;
    zip5?: string | null;
  } | null;
  generated_internal_id: string;
}

export const usaspendingContracts: Connector = {
  id: "usaspending.contracts",
  source: "usaspending",
  dataset: "contract_awards",
  label: "Federal contract awards",
  description: "New federal contracts over $250K awarded to manufacturers (USASpending.gov).",
  category: "contracts",
  defaultLookbackDays: 120,
  schedule: "daily",
  disabledReason: () => null,

  async fetch(ctx) {
    const today = new Date().toISOString().slice(0, 10);
    const records: RawRecord[] = [];
    let page = 1;
    while (records.length < ctx.limit) {
      const res = await fetchWithRetry(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: {
            award_type_codes: ["A", "B", "C", "D"],
            time_period: [{ start_date: ctx.since, end_date: today, date_type: "new_awards_only" }],
            naics_codes: { require: ["31", "32", "33"] },
            award_amounts: [{ lower_bound: 250000 }],
          },
          fields: FIELDS,
          limit: 50,
          page,
          sort: "Award Amount",
          order: "desc",
        }),
      });
      if (!res.ok) throw new Error(`USASpending ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { results: AwardRow[]; page_metadata: { hasNext: boolean } };
      for (const r of body.results) {
        const loc = r["Recipient Location"] ?? {};
        records.push({
          source: "usaspending",
          dataset: "contract_awards",
          external_id: r.generated_internal_id ?? r["Award ID"],
          record_type: "contract_award",
          occurred_on: r["Base Obligation Date"] ?? r["Start Date"],
          entity_name: str(r["Recipient Name"]),
          entity_street: str(loc.address_line1),
          entity_city: str(loc.city_name),
          entity_state: str(loc.state_code),
          entity_postal_code: str(loc.zip5),
          entity_identifiers: r["Recipient UEI"] ? { uei: r["Recipient UEI"] } : {},
          amount: num(r["Award Amount"]),
          url: `https://www.usaspending.gov/award/${encodeURIComponent(r.generated_internal_id)}`,
          raw: r as unknown as Record<string, unknown>,
        });
      }
      ctx.log(`page ${page}: ${body.results.length} awards`);
      if (!body.page_metadata?.hasNext || body.results.length === 0) break;
      page += 1;
    }
    return { records: records.slice(0, ctx.limit) };
  },

  toSignals(rec) {
    if (!rec.occurred_on) return [];
    const r = rec.raw as unknown as AwardRow;
    const amount = rec.amount ?? 0;
    const agency = r["Awarding Sub Agency"] ?? r["Awarding Agency"] ?? "a federal agency";
    const desc = (r.Description ?? "").toLowerCase();
    return [{
      category: "contracts",
      signal_type: "contract_award",
      title: `Won a ${formatMoney(amount)} federal contract`,
      detail: `${agency}${r.Description ? ` — ${titleSentence(r.Description)}` : ""}`,
      occurred_on: rec.occurred_on,
      amount,
      location: r["Place of Performance State Code"] ?? null,
      source_url: rec.url ?? null,
      attributes: { agency, naics: r.naics_code, naics_description: r.naics_description, award_id: r["Award ID"] },
      // bigger awards and production/manufacture language read as new capacity
      strength: Math.min(90, 40 + Math.round(Math.log10(Math.max(amount, 1)) * 5) + (/(manufactur|production|fabricat|assembl)/.test(desc) ? 10 : 0)),
    }];
  },
};

/** USASpending can be slow on large searches: 150s timeout, one retry on timeout/5xx. */
async function fetchWithRetry(url: string, init: RequestInit, attempt = 0): Promise<Response> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(150_000) });
    if (res.status >= 500 && attempt === 0) return fetchWithRetry(url, init, 1);
    return res;
  } catch (e) {
    if (attempt === 0 && (e as Error).name === "TimeoutError") return fetchWithRetry(url, init, 1);
    throw e;
  }
}

function titleSentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  const lower = t.toLowerCase();
  const short = lower.length > 180 ? lower.slice(0, 177) + "…" : lower;
  return short.charAt(0).toUpperCase() + short.slice(1);
}
