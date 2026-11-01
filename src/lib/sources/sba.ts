import Papa from "papaparse";
import { Readable } from "node:stream";
import type { Connector, RawRecord } from "./types";
import { num, str } from "./types";
import { serverEnv } from "@/lib/env";
import { formatMoney, toIsoDate } from "@/lib/pipeline/normalize";

// SBA 504 and 7(a) loan approvals (SBA FOIA extracts, public domain CSVs,
// refreshed quarterly). 504 loans finance owner-occupied real estate and
// heavy equipment, which is exactly "a loan funds a new building or new
// equipment". File names change every quarter (…_asof_YYMMDD.csv), so the
// connector reads the dataset page and picks the newest FY2010+/FY2020+ file.
// SBA_504_CSV_URL / SBA_7A_CSV_URL override discovery if set.
//
// The file is streamed and filtered row by row (NAICS 31–33, approved since
// the lookback date), so memory stays flat even for the 7(a) file.

type Program = "504" | "7a";

function pick(row: Record<string, string>, ...names: string[]): string | null {
  for (const n of names) {
    const key = Object.keys(row).find((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "") === n.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (key && row[key] != null && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  return null;
}

const DATASET_PAGE = "https://data.sba.gov/dataset/7a-504-foia";

/** Finds the newest current-period CSV for a program on the SBA dataset page. */
export async function discoverSbaCsv(program: Program): Promise<string> {
  const res = await fetch(DATASET_PAGE, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`SBA dataset page ${res.status}`);
  const html = await res.text();
  const pattern = program === "504" ? /FOIA_504_FY2010_Present_asof_(\d{6})\.csv/ : /FOIA_7a_FY2020_Present_asof_(\d{6})\.csv/;
  const links = [...new Set(html.match(/https?:\/\/[^"'\s]+\.csv/g) ?? [])]
    .map((url) => ({ url, asof: url.match(pattern)?.[1] }))
    .filter((l): l is { url: string; asof: string } => Boolean(l.asof))
    .sort((a, b) => b.asof.localeCompare(a.asof));
  if (!links.length) throw new Error(`No ${program} CSV found on ${DATASET_PAGE}`);
  return links[0].url;
}

function sbaConnector(program: Program): Connector {
  const dataset = program === "504" ? "foia_504" : "foia_7a";
  const urlFor = () => (program === "504" ? serverEnv.sba504CsvUrl() : serverEnv.sba7aCsvUrl());
  return {
    id: `sba.${dataset}`,
    source: "sba",
    dataset,
    label: program === "504" ? "SBA 504 loans" : "SBA 7(a) loans",
    description:
      program === "504"
        ? "SBA 504 loans to manufacturers — financing for buildings and heavy equipment."
        : "SBA 7(a) loans to manufacturers — working capital, equipment and expansion.",
    category: "money_moving",
    defaultLookbackDays: 365,
    schedule: "weekly",
    disabledReason: () => null,

    async fetch(ctx) {
      const url = urlFor() ?? (await discoverSbaCsv(program));
      ctx.log(`reading ${url}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`SBA CSV ${res.status}`);
      const records: RawRecord[] = [];
      let scanned = 0;

      await new Promise<void>((resolve, reject) => {
        const stream = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream);
        Papa.parse<Record<string, string>>(stream as unknown as File, {
          header: true,
          skipEmptyLines: true,
          step: (result, parser) => {
            scanned++;
            const row = result.data;
            const naics = pick(row, "NaicsCode", "NAICS Code");
            if (!naics || !/^3[1-3]/.test(naics)) return;
            const approved = toIsoDate(pick(row, "ApprovalDate", "Approval Date"));
            if (!approved || approved < ctx.since) return;
            const name = pick(row, "BorrName", "Borrower Name");
            if (!name) return;
            const amount = num(pick(row, "GrossApproval", "Gross Approval"));
            const lender = pick(row, "CDC_Name", "ThirdPartyLender_Name", "BankName", "Bank Name");
            records.push({
              source: "sba",
              dataset,
              external_id: `${program}:${name}:${approved}:${amount ?? ""}`,
              record_type: program === "504" ? "sba_504_loan" : "sba_7a_loan",
              occurred_on: approved,
              entity_name: name,
              entity_street: pick(row, "BorrStreet", "Borrower Street"),
              entity_city: pick(row, "BorrCity", "Borrower City"),
              entity_state: pick(row, "BorrState", "Borrower State"),
              entity_postal_code: pick(row, "BorrZip", "Borrower Zip"),
              amount,
              url: DATASET_PAGE,
              raw: { ...row, _lender: lender, _naics: naics },
            });
            if (records.length >= ctx.limit) parser.abort();
          },
          complete: () => resolve(),
          error: (err: Error) => reject(err),
        });
      });
      ctx.log(`scanned ${scanned} rows, kept ${records.length} manufacturer loans`);
      return { records };
    },

    toSignals(rec) {
      if (!rec.occurred_on) return [];
      const r = rec.raw as Record<string, string>;
      const amount = rec.amount ?? null;
      const jobs = num(pick(r, "JobsSupported", "Jobs Supported"));
      const purpose = program === "504" ? "building or heavy equipment" : "expansion or equipment";
      return [{
        category: "money_moving",
        signal_type: program === "504" ? "sba_504_loan" : "sba_7a_loan",
        title: `${program === "504" ? "SBA 504" : "SBA 7(a)"} loan approved${amount ? `, ${formatMoney(amount)}` : ""}`,
        detail: `Financing for ${purpose}${r._lender ? ` via ${r._lender}` : ""}${jobs ? ` · supports ${jobs} jobs` : ""}`,
        occurred_on: rec.occurred_on,
        amount,
        location: [rec.entity_city, rec.entity_state].filter(Boolean).join(", "),
        source_url: rec.url ?? null,
        attributes: { lender: r._lender ?? null, naics: r._naics, jobs_supported: jobs, term_months: num(pick(r, "TermInMonths")) },
        strength: program === "504" ? (amount && amount > 1_000_000 ? 70 : 60) : 45,
      }];
    },
  };
}

export const sba504 = sbaConnector("504");
export const sba7a = sbaConnector("7a");
export const _pickForTest = pick;
export const _str = str;
