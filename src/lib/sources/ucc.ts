import type { Connector, RawRecord } from "./types";
import { MANUFACTURING_NAME_HINTS, str } from "./types";
import { toIsoDate } from "@/lib/pipeline/normalize";

// Connecticut UCC lien filings (data.ct.gov xfev-8smz) — public domain, daily,
// the only free open UCC feed. A new Original Financing Statement where the
// secured party is an equipment lender and the debtor looks like a
// manufacturer is a financed-equipment event. Collateral text is not in the
// open data, so the signal is "equipment financing filed", not "machine X".

const BASE = "https://data.ct.gov/resource/xfev-8smz.json";
const LENDER_TERMS = ["EQUIPMENT", "LEASING", "VENDOR FIN", "FINANCIAL SERVICES", "CAPITAL FINANCE", "DE LAGE LANDEN", "CATERPILLAR FINANCIAL"];
const NOT_LENDER = /\b(TAX COLLECTOR|INTERNAL REVENUE|DEPARTMENT OF|STATE OF|CITY OF|TOWN OF|COMMISSIONER)\b/;

export const ctUcc: Connector = {
  id: "ucc.ct",
  source: "ucc",
  dataset: "ct_lien_filings",
  label: "Equipment financing (UCC-1, Connecticut)",
  description: "New UCC-1 filings by equipment lenders against Connecticut manufacturers (CT Secretary of the State open data).",
  category: "money_moving",
  defaultLookbackDays: 120,
  schedule: "daily",
  disabledReason: () => null,

  async fetch(ctx) {
    const records: RawRecord[] = [];
    const lenderWhere = LENDER_TERMS.map((t) => `upper(sec_party_nm_bus) like '%${t}%'`).join(" OR ");
    const pageSize = 1000;
    for (let offset = 0; records.length < ctx.limit && offset < 20_000; offset += pageSize) {
      const params = new URLSearchParams({
        $where: `cd_flng_type = 'ORIG FIN STMT' AND dt_accept >= '${ctx.since}T00:00:00' AND debtor_nm_bus IS NOT NULL AND (${lenderWhere})`,
        $order: "dt_accept DESC",
        $limit: String(pageSize),
        $offset: String(offset),
      });
      const res = await fetch(`${BASE}?${params}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`data.ct.gov ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const rows = (await res.json()) as Record<string, string>[];
      for (const r of rows) {
        const debtor = str(r.debtor_nm_bus);
        const lender = str(r.sec_party_nm_bus) ?? "";
        if (!debtor || NOT_LENDER.test(lender.toUpperCase()) || !MANUFACTURING_NAME_HINTS.test(debtor.toUpperCase())) continue;
        records.push({
          source: "ucc",
          dataset: "ct_lien_filings",
          external_id: String(r.id_ucc_flng_nbr ?? r.id_lien_flng_nbr),
          record_type: "ucc1_equipment_financing",
          occurred_on: toIsoDate(r.dt_accept),
          entity_name: debtor,
          entity_street: str(r.debtor_ad_str1),
          entity_city: str(r.debtor_ad_city),
          entity_state: str(r.debtor_ad_state) ?? "CT",
          entity_postal_code: str(r.debtor_ad_zip),
          url: `https://data.ct.gov/resource/xfev-8smz.json?id_ucc_flng_nbr=${encodeURIComponent(String(r.id_ucc_flng_nbr ?? ""))}`,
          raw: { lender, lapse: r.dt_lapse, status: r.lien_status, type: r.cd_flng_type },
        });
      }
      ctx.log(`offset ${offset}: ${rows.length} lender filings, ${records.length} manufacturer debtors`);
      if (rows.length < pageSize) break;
    }
    return { records: records.slice(0, ctx.limit) };
  },

  toSignals(rec) {
    if (!rec.occurred_on) return [];
    const lender = String((rec.raw as { lender?: string }).lender ?? "an equipment lender");
    return [{
      category: "money_moving",
      signal_type: "ucc1_equipment_financing",
      title: "Equipment financing filed (UCC-1)",
      detail: `Secured party: ${lender}`,
      occurred_on: rec.occurred_on,
      location: [rec.entity_city, rec.entity_state].filter(Boolean).join(", "),
      source_url: rec.url ?? null,
      attributes: { lender },
      strength: 45,
    }];
  },
};
