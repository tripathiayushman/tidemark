import type { Connector, RawRecord, SignalDraft } from "./types";
import { looksLikeBusiness, num, str } from "./types";
import { formatMoney } from "@/lib/pipeline/normalize";

// Building permits from city open-data portals (Socrata SODA API, no key).
// Industrial / manufacturing work only. Add a city by adding a config entry;
// field names differ per portal so each config maps its own columns.

interface CityConfig {
  dataset: string;           // our dataset id
  city: string;
  state: string;
  domain: string;            // socrata host
  resource: string;          // 4x4 id
  dateField: string;
  where: string;             // SoQL filter for industrial work (dates appended)
  map: (row: Record<string, unknown>) => {
    id: string;
    owner: string | null;
    street: string | null;
    zip: string | null;
    description: string | null;
    permitType: string | null;
    status: string | null;
    cost: number | null;
    issued: string | null;
  };
}

const INDUSTRIAL_TERMS = ["MANUFACTUR", "INDUSTRIAL", "FACTORY", "PRODUCTION", "FABRICAT", "MACHINE SHOP", "WAREHOUSE", "PROCESSING PLANT", "FOOD PROCESSING", "DISTRIBUTION CENTER"];

export const PERMIT_CITIES: CityConfig[] = [
  {
    dataset: "chicago_building_permits",
    city: "Chicago",
    state: "IL",
    domain: "data.cityofchicago.org",
    resource: "ydr8-5enu",
    dateField: "issue_date",
    where: `(${INDUSTRIAL_TERMS.map((t) => `upper(work_description) like '%${t}%'`).join(" OR ")}) AND (permit_type like '%NEW CONSTRUCTION%' OR permit_type like '%RENOVATION%')`,
    map: (r) => {
      // owner is one of contact_1..contact_15 with type OWNER
      let owner: string | null = null;
      for (let i = 1; i <= 15; i++) {
        if (String(r[`contact_${i}_type`] ?? "").toUpperCase() === "OWNER") {
          owner = str(r[`contact_${i}_name`]);
          break;
        }
      }
      const street = [r.street_number, r.street_direction, r.street_name].filter(Boolean).join(" ");
      return {
        id: String(r.id ?? r.permit_),
        owner,
        street: street || null,
        zip: null,
        description: str(r.work_description),
        permitType: str(r.permit_type),
        status: str(r.permit_status),
        cost: num(r.reported_cost),
        issued: str(r.issue_date),
      };
    },
  },
];

function cityConnector(cfg: CityConfig): Connector {
  return {
    id: `permits.${cfg.dataset}`,
    source: "permits",
    dataset: cfg.dataset,
    label: `${cfg.city} building permits`,
    description: `Industrial and manufacturing building permits issued in ${cfg.city}, ${cfg.state}.`,
    category: "building",
    defaultLookbackDays: 180,
    schedule: "daily",
    disabledReason: () => null,

    async fetch(ctx) {
      const records: RawRecord[] = [];
      const pageSize = 500;
      for (let offset = 0; records.length < ctx.limit; offset += pageSize) {
        const params = new URLSearchParams({
          $where: `${cfg.dateField} >= '${ctx.since}T00:00:00' AND (${cfg.where})`,
          $order: `${cfg.dateField} DESC`,
          $limit: String(pageSize),
          $offset: String(offset),
        });
        const res = await fetch(`https://${cfg.domain}/resource/${cfg.resource}.json?${params}`, {
          signal: AbortSignal.timeout(60_000),
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`${cfg.domain} ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const rows = (await res.json()) as Record<string, unknown>[];
        for (const row of rows) {
          const m = cfg.map(row);
          if (!looksLikeBusiness(m.owner)) continue;
          records.push({
            source: "permits",
            dataset: cfg.dataset,
            external_id: m.id,
            record_type: "building_permit",
            occurred_on: m.issued,
            entity_name: m.owner,
            entity_street: m.street,
            entity_city: cfg.city,
            entity_state: cfg.state,
            entity_postal_code: m.zip,
            amount: m.cost,
            url: `https://${cfg.domain}/resource/${cfg.resource}.json?id=${encodeURIComponent(m.id)}`,
            raw: { ...row, _mapped: m },
          });
        }
        ctx.log(`offset ${offset}: ${rows.length} rows, ${records.length} business permits so far`);
        if (rows.length < pageSize) break;
      }
      return { records: records.slice(0, ctx.limit) };
    },

    // Note: Chicago publishes no completion date, so "permit closed out"
    // signals are only produced by portals that expose one (add a
    // closedDateField to the config) — never inferred from the issue date.
    toSignals(rec): SignalDraft[] {
      if (!rec.occurred_on) return [];
      const m = (rec.raw as { _mapped?: ReturnType<CityConfig["map"]> })._mapped;
      const desc = m?.description ?? "";
      const isNew = /NEW CONSTRUCTION/i.test(m?.permitType ?? "");
      const cost = rec.amount ?? null;
      const signals: SignalDraft[] = [{
        category: "building",
        signal_type: isNew ? "permit_new_construction" : "permit_renovation",
        title: isNew ? "Building permit approved for new construction" : "Building permit approved",
        detail: `${cost ? `${formatMoney(cost)} · ` : ""}${shorten(desc)}${m?.street ? ` · ${m.street}` : ""}`,
        occurred_on: rec.occurred_on.slice(0, 10),
        amount: cost,
        location: [m?.street, cfg.city, cfg.state].filter(Boolean).join(", "),
        source_url: rec.url ?? null,
        attributes: { permit_type: m?.permitType, status: m?.status },
        strength: (isNew ? 60 : 45) + (cost && cost > 1_000_000 ? 15 : cost && cost > 250_000 ? 8 : 0),
      }];
      return signals;
    },
  };
}

function shorten(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const sentence = t.charAt(0) + t.slice(1).toLowerCase();
  return sentence.length > 160 ? sentence.slice(0, 157) + "…" : sentence;
}

export const permitConnectors: Connector[] = PERMIT_CITIES.map(cityConnector);
