import type { RecordSource, SignalCategory } from "@/lib/types";

/** A record as fetched from a dataset, before company matching. */
export interface RawRecord {
  source: RecordSource;
  dataset: string;
  external_id: string;
  record_type: string;
  occurred_on: string | null;
  entity_name: string | null;
  entity_street?: string | null;
  entity_city?: string | null;
  entity_state?: string | null;
  entity_postal_code?: string | null;
  entity_identifiers?: Record<string, string>;
  amount?: number | null;
  url?: string | null;
  raw: Record<string, unknown>;
  is_synthetic?: boolean;
}

/** Stored row shape the resolver hands back to the connector. */
export interface StoredRecord extends RawRecord {
  id: string;
  company_id: string | null;
}

export interface SignalDraft {
  category: SignalCategory;
  signal_type: string;
  title: string;
  detail?: string | null;
  occurred_on: string;
  amount?: number | null;
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  source_url?: string | null;
  attributes?: Record<string, unknown>;
  strength: number; // 0..100: how strongly this record alone suggests a buying event
}

export interface FetchContext {
  since: string;          // ISO date
  limit: number;          // max records this run
  cursor: Record<string, unknown>;
  log: (msg: string) => void;
}

export interface FetchResult {
  records: RawRecord[];
  cursor?: Record<string, unknown>;
  /** Optional side effects, e.g. fleet snapshots, applied after records are stored. */
  metrics?: { usdot: string; metric: string; value: number; observed_on: string }[];
}

export interface Connector {
  id: string;                  // "usaspending.contracts"
  source: RecordSource;
  dataset: string;
  label: string;
  description: string;
  category: SignalCategory;
  defaultLookbackDays: number;
  schedule: "daily" | "weekly" | "manual";
  /** Only attach records to companies we already know; never create new ones (e.g. layoff notices). */
  matchOnly?: boolean;
  /** Why it is disabled, or null when ready to run. */
  disabledReason(): string | null;
  fetch(ctx: FetchContext): Promise<FetchResult>;
  /** Turns a stored record into zero or more signals. */
  toSignals(rec: StoredRecord): SignalDraft[];
}

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** True if the name looks like an operating business rather than a person or a parcel LLC. */
export function looksLikeBusiness(name: string | null): boolean {
  if (!name) return false;
  const n = name.toUpperCase();
  if (/^\d/.test(n)) return false; // "1200 W FULTON LLC" style property shells
  if (/\b(TRUST|TRUSTEE|ESTATE OF|CITY OF|COUNTY|DEPARTMENT|BOARD OF|SCHOOL|CHURCH|UNIVERSITY|HOUSING AUTHORITY)\b/.test(n)) return false;
  return /\b(INC|LLC|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP|INDUSTRIES|MANUFACTURING|MFG|FABRICAT\w*|MACHINE\w*|METALS?|PLASTICS?|FOODS?|PRODUCTS?|SYSTEMS?|TECHNOLOGIES|ENTERPRISES|WORKS|GROUP|HOLDINGS)\b/.test(n);
}

export const MANUFACTURING_NAME_HINTS =
  /\b(MANUFACTUR\w*|MFG|FABRICAT\w*|MACHIN\w*|METALS?|STEEL|ALUMINUM|PLASTICS?|MOLD\w*|CASTING\w*|FORG\w*|STAMPING|TOOL\w*|DIE|WELD\w*|INDUSTRIES|INDUSTRIAL|FOODS?|BEVERAGE\w*|PACKAG\w*|CHEMICAL\w*|COATING\w*|PRECISION|COMPONENTS?|ELECTRONICS?|TRAILERS?|TRUCK BOD\w*|CABINET\w*|MILLWORK|PRINTING|PAPER|TEXTILE\w*|RUBBER|GLASS|CONCRETE|LUMBER|WOOD\w*|BREWING|DISTILL\w*|BAKERY|BAKING|MEATS?|DAIRY|PHARMA\w*)\b/;
