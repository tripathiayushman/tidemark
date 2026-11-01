import { createHash } from "node:crypto";

// Provider-neutral pieces of the CRM sync: the adapter contract HubSpot and
// Attio implement, the Tidemark property definitions, and the pure mapping /
// merge rules the engine in ./index.ts applies.
//
// Invariants (product spec):
//   * Nothing here or in an adapter ever deletes a CRM record. Adapters expose
//     no delete operation at all, and list sync only adds members.
//   * Tidemark never blanks a CRM field: an empty local value is never pushed.

export type CrmProvider = "hubspot" | "attio";

export const CRM_LABEL: Record<CrmProvider, string> = { hubspot: "HubSpot", attio: "Attio" };

export function isCrmProvider(p: string): p is CrmProvider {
  return p === "hubspot" || p === "attio";
}

// ── Property definitions ─────────────────────────────────────────────────────

export type FieldType = "text" | "longtext" | "number" | "date" | "boolean" | "select" | "url";
export type FieldValue = string | number | boolean;

export interface SelectOption {
  label: string;
  value: string;
}

export interface PropertyDef {
  key: string; // HubSpot property name / Attio attribute api_slug
  label: string;
  description: string;
  type: FieldType;
  options?: SelectOption[];
  columnId?: string; // set for custom columns
}

export const TIDEMARK_GROUP = { name: "tidemark", label: "Tidemark" } as const;
export const CUSTOM_COLUMN_PREFIX = "tidemark_cc_";

/** Tidemark's reasoning, written onto the CRM company. */
export const COMPANY_PROPERTIES: PropertyDef[] = [
  { key: "tidemark_id", label: "Tidemark ID", description: "Tidemark account id (used to match records)", type: "text" },
  {
    key: "tidemark_tier",
    label: "Tidemark tier",
    description: "Tidemark prospect tier",
    type: "select",
    options: ["S", "A", "B", "C"].map((t) => ({ label: t, value: t })),
  },
  { key: "tidemark_score", label: "Tidemark score", description: "Tidemark score, 0-100", type: "number" },
  { key: "tidemark_reason_to_buy", label: "Tidemark reason to buy", description: "Why this company may buy now", type: "longtext" },
  { key: "tidemark_timing", label: "Tidemark timing", description: "Tidemark timing label", type: "text" },
  { key: "tidemark_contact_window_start", label: "Tidemark contact window start", description: "Best time to reach out begins", type: "date" },
  { key: "tidemark_contact_window_end", label: "Tidemark contact window end", description: "Best time to reach out ends", type: "date" },
  { key: "tidemark_why", label: "Tidemark why", description: "How the records tie to what you sell", type: "longtext" },
  { key: "tidemark_url", label: "Open in Tidemark", description: "Link to this prospect in Tidemark", type: "url" },
];

/** Written onto CRM contacts / people. */
export const PERSON_PROPERTIES: PropertyDef[] = [
  { key: "tidemark_id", label: "Tidemark ID", description: "Tidemark contact id (used to match records)", type: "text" },
];

export interface CustomColumnRow {
  id: string;
  name: string;
  key: string;
  data_type: string;
  options: unknown;
}

export function normalizeOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) return [];
  const out: SelectOption[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    let label: string | null = null;
    let value: string | null = null;
    if (typeof o === "string" || typeof o === "number") {
      label = value = String(o).trim();
    } else if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      value = str(r.value ?? r.key ?? r.label ?? r.name);
      label = str(r.label ?? r.name ?? r.value);
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ label: label || value, value });
  }
  return out;
}

/** custom_columns row → CRM property definition (company level). */
export function customColumnProperty(col: CustomColumnRow): PropertyDef {
  const options = normalizeOptions(col.options);
  const known: FieldType[] = ["text", "number", "date", "boolean", "select", "url"];
  let type: FieldType = known.includes(col.data_type as FieldType) ? (col.data_type as FieldType) : "text";
  // A dropdown with no options would reject every value — store it as text.
  if (type === "select" && options.length === 0) type = "text";
  return {
    key: `${CUSTOM_COLUMN_PREFIX}${col.key}`,
    label: col.name,
    description: "Tidemark custom column",
    type,
    options: type === "select" ? options : undefined,
    columnId: col.id,
  };
}

/** Changes whenever the property set we need to provision changes. */
export function schemaKey(defs: PropertyDef[]): string {
  const SCHEMA_VERSION = 1;
  const payload = JSON.stringify([SCHEMA_VERSION, defs.map((d) => [d.key, d.type, d.options?.map((o) => o.value) ?? []])]);
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

// ── Value mapping ────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

export function clean(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  return s.length ? s : null;
}

/** account_field_values.value (jsonb) → CRM value for a property of `type`. */
export function toFieldValue(def: PropertyDef, type: FieldType, raw: unknown): FieldValue | null {
  let v = raw;
  if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as Record<string, unknown>)) {
    v = (v as Record<string, unknown>).value;
  }
  if (v == null || v === "") return null;
  switch (type) {
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof v === "boolean") return v;
      const s = String(v).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return true;
      if (["false", "no", "n", "0"].includes(s)) return false;
      return null;
    }
    case "date":
      return toDate(v);
    case "select": {
      const s = String(v).trim();
      const opt = def.options?.find((o) => o.value === s || o.label === s);
      return opt ? opt.value : null;
    }
    default: {
      const s = Array.isArray(v) ? v.map((x) => String(x)).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
      return clean(s)?.slice(0, 65_000) ?? null;
    }
  }
}

export function toDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export interface AccountForPush {
  id: string;
  tier: string | null;
  score: number | null;
  reason_to_buy: string | null;
  why: string | null;
  timing_label: string | null;
  contact_window_start: string | null;
  contact_window_end: string | null;
}

/** Tidemark-owned company properties. Nulls are dropped (never blank the CRM). */
export function companyFieldValues(a: AccountForPush, appUrl: string): Record<string, FieldValue> {
  const raw: Record<string, FieldValue | null> = {
    tidemark_id: a.id,
    tidemark_tier: a.tier,
    tidemark_score: a.score,
    tidemark_reason_to_buy: clean(a.reason_to_buy),
    tidemark_timing: clean(a.timing_label),
    tidemark_contact_window_start: toDate(a.contact_window_start),
    tidemark_contact_window_end: toDate(a.contact_window_end),
    tidemark_why: clean(a.why),
    tidemark_url: `${appUrl.replace(/\/$/, "")}/prospects/${a.id}`,
  };
  const out: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(raw)) if (v != null) out[k] = v;
  return out;
}

export function normalizeDomain(d: string | null | undefined): string | null {
  const s = clean(d)?.toLowerCase();
  if (!s) return null;
  const host = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
  return host.includes(".") ? host : null;
}

// ── People ───────────────────────────────────────────────────────────────────

/** The fields Tidemark syncs both ways for a person. */
export const PERSON_FIELDS = ["name", "email", "title", "phone", "linkedin"] as const;
export type PersonField = (typeof PERSON_FIELDS)[number];

export interface PersonValues {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  title: string | null;
  phone: string | null;
  linkedinUrl: string | null;
}

export interface RemotePerson {
  id: string;
  values: PersonValues;
  emails: string[]; // every email on the record, lowercased
  phones: string[]; // every phone on the record
  /** epoch ms each synced field last changed in the CRM (when known) */
  fieldTs: Partial<Record<PersonField, number>>;
  /** max(fieldTs) — what crm_links.remote_updated_at stores */
  version: number | null;
  companyIds: string[]; // empty when the provider didn't report them
  tidemarkId: string | null;
}

export interface RemoteCompany {
  id: string;
  name: string | null;
  domain: string | null;
  tidemarkId: string | null;
}

export interface ContactLike {
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
}

export function splitName(full: string | null): { first: string | null; last: string | null } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

export function joinName(first: string | null, last: string | null): string | null {
  return clean([first, last].filter(Boolean).join(" "));
}

export function localPersonValues(c: ContactLike): PersonValues {
  const split = splitName(c.full_name);
  const first = clean(c.first_name) ?? split.first;
  const last = clean(c.last_name) ?? split.last;
  return {
    firstName: first,
    lastName: last,
    fullName: clean(c.full_name) ?? joinName(first, last),
    email: clean(c.email)?.toLowerCase() ?? null,
    title: clean(c.title),
    phone: clean(c.phone),
    linkedinUrl: clean(c.linkedin_url),
  };
}

export function phoneKey(p: string | null | undefined): string | null {
  const digits = (p ?? "").replace(/\D/g, "");
  if (digits.length < 7) return digits.length ? digits : null;
  return digits.slice(-10); // ignore country prefix differences (+1 vs none)
}

export function linkedinKey(u: string | null | undefined): string | null {
  const s = clean(u)?.toLowerCase();
  if (!s) return null;
  return s.replace(/^[a-z]+:\/\//, "").replace(/^(www|[a-z]{2})\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function nameKey(v: PersonValues): string {
  return (v.fullName ?? joinName(v.firstName, v.lastName) ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function fieldBlank(f: PersonField, v: PersonValues): boolean {
  switch (f) {
    case "name":
      return !nameKey(v);
    case "email":
      return !v.email;
    case "title":
      return !v.title;
    case "phone":
      return !phoneKey(v.phone);
    case "linkedin":
      return !linkedinKey(v.linkedinUrl);
  }
}

export function fieldSame(f: PersonField, local: PersonValues, remote: RemotePerson): boolean {
  const r = remote.values;
  switch (f) {
    case "name":
      return nameKey(local) === nameKey(r);
    case "email":
      return !local.email ? !r.email : remote.emails.includes(local.email.toLowerCase());
    case "title":
      return (local.title ?? "") === (r.title ?? "");
    case "phone": {
      const k = phoneKey(local.phone);
      if (!k) return remote.phones.every((p) => !phoneKey(p));
      return remote.phones.some((p) => phoneKey(p) === k);
    }
    case "linkedin":
      return linkedinKey(local.linkedinUrl) === linkedinKey(r.linkedinUrl);
  }
}

/** Remote timestamps within this window of our own write count as our write. */
export const VERSION_TOLERANCE_MS = 5_000;

export type Direction = "pull" | "push" | "none";

/**
 * Which way a differing field should flow.
 *   firstLink   person existed in the CRM before Tidemark linked it: the CRM
 *               value wins conflicts, Tidemark only fills CRM blanks.
 *   linked      a CRM edit since we last saw the record wins; otherwise a
 *               local change since the last sync is pushed; otherwise the CRM
 *               differs for a reason we couldn't timestamp, so it wins.
 * Tidemark never blanks a CRM field, and never clears a local name or email.
 */
export function decideField(
  f: PersonField,
  local: PersonValues,
  remote: RemotePerson,
  o: { firstLink: boolean; lastSeen: number | null; localDirty: boolean },
): Direction {
  if (fieldSame(f, local, remote)) return "none";
  const localBlank = fieldBlank(f, local);
  const remoteBlank = fieldBlank(f, remote.values);
  const keepLocal = f === "name" || f === "email"; // never cleared locally
  if (o.firstLink) {
    if (remoteBlank) return localBlank ? "none" : "push";
    return "pull";
  }
  if (localBlank) return remoteBlank ? "none" : "pull";
  const ts = remote.fieldTs[f];
  const remoteChanged = ts != null && (o.lastSeen == null || ts > o.lastSeen + VERSION_TOLERANCE_MS);
  if (remoteBlank) {
    if (keepLocal) return "push";
    if (remoteChanged) return "pull";
    return o.localDirty ? "push" : "pull";
  }
  if (remoteChanged || !o.localDirty) return "pull";
  return "push";
}

/** Local contact columns for pulling `f` from the CRM. */
export function pullPatch(f: PersonField, remote: PersonValues): Record<string, string | null> {
  switch (f) {
    case "name": {
      const full = remote.fullName ?? joinName(remote.firstName, remote.lastName);
      if (!full) return {};
      return { full_name: full, first_name: remote.firstName, last_name: remote.lastName };
    }
    case "email":
      return remote.email ? { email: remote.email.toLowerCase() } : {};
    case "title":
      return { title: remote.title };
    case "phone":
      return { phone: remote.phone };
    case "linkedin":
      return { linkedin_url: remote.linkedinUrl };
  }
}

/** Person values to send for pushing `f` (never blanks). */
export function pushPatch(f: PersonField, local: PersonValues): Partial<PersonValues> {
  switch (f) {
    case "name":
      return nameKey(local) ? { firstName: local.firstName, lastName: local.lastName, fullName: local.fullName } : {};
    case "email":
      return local.email ? { email: local.email } : {};
    case "title":
      return local.title ? { title: local.title } : {};
    case "phone":
      return local.phone ? { phone: local.phone } : {};
    case "linkedin":
      return local.linkedinUrl ? { linkedinUrl: local.linkedinUrl } : {};
  }
}

// ── Adapter contract ─────────────────────────────────────────────────────────

export interface CompanyWrite {
  accountId: string;
  remoteId: string | null; // null → find-or-create (name/domain only set on create)
  name: string;
  domain: string | null;
  fields: Record<string, FieldValue>; // Tidemark + custom column properties
}

export interface PersonWrite {
  contactId: string;
  remoteId: string | null; // null → create
  set: Partial<PersonValues>; // only the fields to write
  tidemarkId?: string;
  companyRemoteId?: string | null; // associate person → company
}

export interface WriteResult {
  key: string; // accountId / contactId
  remoteId?: string;
  created?: boolean;
  version?: number | null;
  error?: string; // the write failed (nothing to link)
  warning?: string; // the write succeeded but a follow-up (e.g. association) failed
}

/** CRM-side name of a Tidemark list (prefixed so it never collides with the team's own lists). */
export function crmListName(name: string): string {
  return `Tidemark: ${name}`;
}

export interface SchemaResult {
  /** property keys that exist remotely and can be written, with their effective type */
  available: Map<string, FieldType>;
  errors: string[];
}

export interface CrmAdapter {
  readonly provider: CrmProvider;
  readonly label: string;
  /** Idempotently provision the Tidemark group/properties and custom columns. */
  ensureSchema(customColumns: PropertyDef[], opts: { syncOptions: boolean }): Promise<SchemaResult>;
  findCompanies(q: { tidemarkIds: string[]; domains: string[] }): Promise<{ byTidemarkId: Map<string, RemoteCompany>; byDomain: Map<string, RemoteCompany> }>;
  writeCompanies(items: CompanyWrite[]): Promise<WriteResult[]>;
  findPeopleByEmail(emails: string[]): Promise<Map<string, RemotePerson>>;
  getPeople(ids: string[]): Promise<Map<string, RemotePerson>>;
  writePeople(items: PersonWrite[]): Promise<WriteResult[]>;
  /** Remote company ids a person is associated with (for import). */
  personCompanyIds(remote: RemotePerson): Promise<string[]>;
  getCompanies(ids: string[]): Promise<RemoteCompany[]>;
  /** Find or create the CRM list mirroring a Tidemark list; returns its remote id. */
  ensureList(list: { id: string; name: string }): Promise<string>;
  /** Add companies to a CRM list. Never removes members. */
  addToList(remoteListId: string, companyRemoteIds: string[]): Promise<number>;
}

// ── Small utilities ──────────────────────────────────────────────────────────

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Map with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** apiFetch formats failures as "METHOD host/path → STATUS: body". */
export function httpStatus(e: unknown): number | null {
  const m = /→ (\d{3}):/.exec(errMessage(e));
  return m ? Number(m[1]) : null;
}

export function isAuthError(e: unknown): boolean {
  return httpStatus(e) === 401;
}

export function isNotFound(e: unknown): boolean {
  return httpStatus(e) === 404;
}

export function isConflict(e: unknown): boolean {
  return httpStatus(e) === 409;
}

export function maxTs(...values: (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const v of values) if (v != null && Number.isFinite(v) && (best == null || v > best)) best = v;
  return best;
}

export function parseTs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
