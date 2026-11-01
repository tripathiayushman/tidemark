import { apiFetch, oauthRedirectUri } from "@/lib/integrations/connections";
import { serverEnv } from "@/lib/env";
import {
  COMPANY_PROPERTIES,
  PERSON_PROPERTIES,
  chunk,
  crmListName,
  errMessage,
  httpStatus,
  isAuthError,
  isConflict,
  isNotFound,
  joinName,
  mapLimit,
  maxTs,
  normalizeDomain,
  parseTs,
  splitName,
  type CompanyWrite,
  type CrmAdapter,
  type FieldType,
  type FieldValue,
  type PersonValues,
  type PersonWrite,
  type PropertyDef,
  type RemoteCompany,
  type RemotePerson,
  type SchemaResult,
  type WriteResult,
} from "./shared";

// Attio REST v2: OAuth authorize/token, /v2/self, records (assert / query /
// PATCH-append), attributes + select options, lists + entries. Never issues
// DELETE (removing a list entry would need one, so list sync is add-only).

const API = "https://api.attio.com/v2";
const AUTHORIZE_URL = "https://app.attio.com/authorize";
const TOKEN_URL = "https://app.attio.com/oauth/token";

// Attio scopes are configured on the app (build.attio.com → Scopes), not sent
// in the authorize URL. The app needs these:
export const ATTIO_SCOPES = [
  "record_permission:read-write",
  "object_configuration:read-write",
  "list_configuration:read-write",
  "list_entry:read-write",
];

const WRITE_CONCURRENCY = 4; // Attio allows 25 writes/s

// ── OAuth ────────────────────────────────────────────────────────────────────

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = serverEnv.attioClientId();
  const clientSecret = serverEnv.attioClientSecret();
  if (!clientId || !clientSecret) throw new Error("Attio is not configured (ATTIO_CLIENT_ID / ATTIO_CLIENT_SECRET)");
  return { clientId, clientSecret };
}

export function attioAuthorizeUrl(state: string): string {
  const { clientId } = credentials();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", oauthRedirectUri("attio"));
  url.searchParams.set("state", state);
  return url.toString();
}

export interface AttioTokenResponse {
  access_token: string;
  token_type?: string;
  // UNVERIFIED: Attio documents only access_token + token_type (workspace
  // tokens don't expire, /v2/self reports exp: null). Kept in case it changes.
  refresh_token?: string;
  expires_in?: number;
}

export async function exchangeAttioCode(code: string): Promise<AttioTokenResponse> {
  const { clientId, clientSecret } = credentials();
  return apiFetch<AttioTokenResponse>(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri("attio"),
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
}

export interface AttioSelf {
  active: boolean;
  scope?: string;
  workspace_id?: string;
  workspace_name?: string;
  workspace_slug?: string;
}

export async function attioIdentify(accessToken: string): Promise<AttioSelf> {
  return apiFetch<AttioSelf>(`${API}/self`, { token: accessToken });
}

// ── API shapes ───────────────────────────────────────────────────────────────

interface AttioValue {
  active_from?: string | null;
  active_until?: string | null;
  attribute_type?: string;
  value?: unknown;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  email_address?: string | null;
  original_phone_number?: string | null;
  phone_number?: string | null;
  domain?: string | null;
  target_object?: string;
  target_record_id?: string;
}

interface AttioRecord {
  id: { record_id: string; object_id?: string; workspace_id?: string };
  created_at?: string;
  web_url?: string;
  values: Record<string, AttioValue[] | undefined>;
}

interface AttioAttribute {
  api_slug: string;
  type: string;
  is_archived?: boolean;
}

interface AttioList {
  id: { list_id: string; workspace_id?: string };
  api_slug: string;
  name?: string;
}

function current(values: AttioValue[] | undefined): AttioValue[] {
  return (values ?? []).filter((v) => !v.active_until);
}

function textOf(values: AttioValue[] | undefined): string | null {
  const v = current(values)[0]?.value;
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function tsOf(values: AttioValue[] | undefined): number | null {
  return maxTs(...current(values).map((v) => parseTs(v.active_from)));
}

function attioType(t: FieldType): string {
  switch (t) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "boolean":
      return "checkbox";
    case "select":
      return "select";
    default: // text, longtext, url
      return "text";
  }
}

function effectiveType(a: AttioAttribute, def: PropertyDef): FieldType {
  switch (a.type) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "checkbox":
      return "boolean";
    case "select":
      return "select";
    case "text":
      return def.type === "longtext" || def.type === "url" ? def.type : "text";
    default:
      return "text";
  }
}

function phoneValue(phone: string): { original_phone_number: string; country_code?: string } {
  const p = phone.trim();
  // Tidemark is US-focused: assume US when the number carries no country prefix.
  return p.startsWith("+") ? { original_phone_number: p } : { original_phone_number: p, country_code: "US" };
}

function isPhoneRejection(e: unknown): boolean {
  return httpStatus(e) === 400 && /phone/i.test(errMessage(e));
}

// ── Adapter ──────────────────────────────────────────────────────────────────

class AttioAdapter implements CrmAdapter {
  readonly provider = "attio" as const;
  readonly label = "Attio";
  private available = new Map<string, FieldType>(); // company attributes we may write
  private defs = new Map<string, PropertyDef>();
  private personTidemarkId = false; // set once ensureSchema confirms the attribute

  constructor(private readonly token: string) {}

  private req<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    return apiFetch<T>(`${API}${path}`, { ...init, token: this.token });
  }

  // ── schema ──

  async ensureSchema(customColumns: PropertyDef[], opts: { syncOptions: boolean }): Promise<SchemaResult> {
    const errors: string[] = [];
    this.available = new Map();
    this.defs = new Map();
    for (const def of [...COMPANY_PROPERTIES, ...customColumns]) {
      this.defs.set(def.key, def);
      const type = await this.ensureAttribute("companies", def, opts.syncOptions, errors);
      if (type) this.available.set(def.key, type);
    }
    this.personTidemarkId = false;
    for (const def of PERSON_PROPERTIES) {
      const type = await this.ensureAttribute("people", def, opts.syncOptions, errors);
      if (type && def.key === "tidemark_id") this.personTidemarkId = true;
    }
    return { available: new Map(this.available), errors };
  }

  private async ensureAttribute(object: "companies" | "people", def: PropertyDef, syncOptions: boolean, errors: string[]): Promise<FieldType | null> {
    const path = `/objects/${object}/attributes`;
    let found: AttioAttribute | null = null;
    try {
      found = (await this.req<{ data: AttioAttribute }>(`${path}/${encodeURIComponent(def.key)}`)).data;
    } catch (e) {
      if (!isNotFound(e)) {
        if (isAuthError(e)) throw e;
        errors.push(`${object}.${def.key}: ${errMessage(e)}`);
        return null;
      }
    }
    if (found) {
      if (found.is_archived) {
        errors.push(`${object}.${def.key}: attribute is archived in Attio — restore it to sync this field`);
        return null;
      }
      const type = effectiveType(found, def);
      if (type === "select" && syncOptions) await this.ensureOptions(object, def, errors);
      return type;
    }
    try {
      await this.req(path, {
        method: "POST",
        json: {
          data: {
            title: def.label,
            description: def.description,
            api_slug: def.key,
            type: attioType(def.type),
            is_required: false,
            is_unique: false,
            is_multiselect: false,
            config: {}, // UNVERIFIED: empty config accepted for text/number/date/checkbox/select
          },
        },
      });
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (!isConflict(e)) {
        errors.push(`${object}.${def.key}: ${errMessage(e)}`);
        return null;
      }
    }
    if (def.type === "select") await this.ensureOptions(object, def, errors);
    return def.type;
  }

  private async ensureOptions(object: "companies" | "people", def: PropertyDef, errors: string[]) {
    for (const o of def.options ?? []) {
      try {
        await this.req(`/objects/${object}/attributes/${encodeURIComponent(def.key)}/options`, { method: "POST", json: { data: { title: o.label } } });
      } catch (e) {
        if (isAuthError(e)) throw e;
        if (!isConflict(e)) errors.push(`${object}.${def.key} option "${o.label}": ${errMessage(e)}`);
      }
    }
  }

  /**
   * Custom attribute values. UNVERIFIED: Attio's examples write single values
   * in shorthand (text "x", number 5, date "YYYY-MM-DD", checkbox true,
   * select "Option title"); that's what we send.
   */
  private serialize(fields: Record<string, FieldValue>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      const type = this.available.get(k);
      if (!type) continue;
      if (type === "select") {
        const opt = this.defs.get(k)?.options?.find((o) => o.value === v);
        out[k] = opt ? opt.label : String(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // ── records ──

  private async query(object: "companies" | "people", filter: Record<string, unknown>, limit: number): Promise<AttioRecord[]> {
    const res = await this.req<{ data: AttioRecord[] }>(`/objects/${object}/records/query`, { method: "POST", json: { filter, limit } });
    return res.data;
  }

  private toCompany(r: AttioRecord): RemoteCompany {
    return {
      id: r.id.record_id,
      name: textOf(r.values.name),
      domain: normalizeDomain(current(r.values.domains)[0]?.domain ?? null),
      tidemarkId: textOf(r.values.tidemark_id),
    };
  }

  async findCompanies(q: { tidemarkIds: string[]; domains: string[] }) {
    const byTidemarkId = new Map<string, RemoteCompany>();
    // Domain matching happens inside writeCompanies (assert on `domains`).
    const byDomain = new Map<string, RemoteCompany>();
    if (q.tidemarkIds.length && this.available.has("tidemark_id")) {
      for (const group of chunk(q.tidemarkIds, 100)) {
        for (const r of await this.query("companies", { tidemark_id: { $in: group } }, 500)) {
          const c = this.toCompany(r);
          if (c.tidemarkId && !byTidemarkId.has(c.tidemarkId)) byTidemarkId.set(c.tidemarkId, c);
        }
      }
    }
    return { byTidemarkId, byDomain };
  }

  async writeCompanies(items: CompanyWrite[]): Promise<WriteResult[]> {
    return mapLimit(items, WRITE_CONCURRENCY, async (i): Promise<WriteResult> => {
      try {
        const fields = this.serialize(i.fields);
        if (i.remoteId) {
          if (Object.keys(fields).length) {
            await this.req(`/objects/companies/records/${encodeURIComponent(i.remoteId)}`, { method: "PATCH", json: { data: { values: fields } } });
          }
          return { key: i.accountId, remoteId: i.remoteId };
        }
        if (i.domain) {
          // Assert on the unique `domains` attribute: updates the team's existing
          // company if there is one, otherwise creates it. Name is not sent here
          // so an existing company keeps its name.
          const rec = (
            await this.req<{ data: AttioRecord }>("/objects/companies/records?matching_attribute=domains", {
              method: "PUT",
              json: { data: { values: { domains: [{ domain: i.domain }], ...fields } } },
            })
          ).data;
          if (!current(rec.values.name).length) {
            await this.req(`/objects/companies/records/${encodeURIComponent(rec.id.record_id)}`, {
              method: "PATCH",
              json: { data: { values: { name: [{ value: i.name }] } } },
            });
          }
          return { key: i.accountId, remoteId: rec.id.record_id };
        }
        const rec = (
          await this.req<{ data: AttioRecord }>("/objects/companies/records", {
            method: "POST",
            json: { data: { values: { name: [{ value: i.name }], ...fields } } },
          })
        ).data;
        return { key: i.accountId, remoteId: rec.id.record_id, created: true };
      } catch (e) {
        if (isAuthError(e)) throw e;
        return { key: i.accountId, error: errMessage(e) };
      }
    });
  }

  async getCompanies(ids: string[]): Promise<RemoteCompany[]> {
    const out: RemoteCompany[] = [];
    for (const group of chunk(ids, 100)) {
      out.push(...(await this.query("companies", { record_id: { $in: group } }, group.length)).map((r) => this.toCompany(r)));
    }
    return out;
  }

  // ── people ──

  private toPerson(r: AttioRecord): RemotePerson {
    const v = r.values;
    const name = current(v.name)[0];
    const emails = current(v.email_addresses)
      .map((e) => e.email_address?.trim().toLowerCase())
      .filter((e): e is string => Boolean(e));
    const phones = current(v.phone_numbers)
      .map((p) => p.original_phone_number ?? p.phone_number ?? null)
      .filter((p): p is string => Boolean(p));
    const first = name?.first_name?.trim() || null;
    const last = name?.last_name?.trim() || null;
    const values: PersonValues = {
      firstName: first,
      lastName: last,
      fullName: name?.full_name?.trim() || joinName(first, last),
      email: emails[0] ?? null,
      title: textOf(v.job_title),
      phone: phones[0] ?? null,
      linkedinUrl: textOf(v.linkedin),
    };
    const fieldTs = {
      name: tsOf(v.name) ?? undefined,
      email: tsOf(v.email_addresses) ?? undefined,
      title: tsOf(v.job_title) ?? undefined,
      phone: tsOf(v.phone_numbers) ?? undefined,
      linkedin: tsOf(v.linkedin) ?? undefined,
    };
    return {
      id: r.id.record_id,
      values,
      emails,
      phones,
      fieldTs,
      version: maxTs(...Object.values(fieldTs)),
      companyIds: current(v.company)
        .map((c) => c.target_record_id)
        .filter((id): id is string => Boolean(id)),
      tidemarkId: textOf(v.tidemark_id),
    };
  }

  async findPeopleByEmail(emails: string[]): Promise<Map<string, RemotePerson>> {
    const wanted = [...new Set(emails.map((e) => e.toLowerCase()))];
    const out = new Map<string, RemotePerson>();
    for (const group of chunk(wanted, 20)) {
      const filter = { $or: group.map((e) => ({ email_addresses: { email_address: { $eq: e } } })) };
      for (const r of await this.query("people", filter, 100)) {
        const person = this.toPerson(r);
        for (const e of person.emails) if (group.includes(e) && !out.has(e)) out.set(e, person);
      }
    }
    return out;
  }

  async getPeople(ids: string[]): Promise<Map<string, RemotePerson>> {
    const out = new Map<string, RemotePerson>();
    for (const group of chunk(ids, 100)) {
      for (const r of await this.query("people", { record_id: { $in: group } }, group.length)) out.set(r.id.record_id, this.toPerson(r));
    }
    return out;
  }

  private personValues(w: PersonWrite): Record<string, unknown> {
    const s = w.set;
    const values: Record<string, unknown> = {};
    if (s.firstName !== undefined || s.lastName !== undefined || s.fullName !== undefined) {
      const split = splitName(s.fullName ?? null);
      const first = s.firstName ?? split.first;
      const last = s.lastName ?? split.last;
      const full = s.fullName ?? joinName(first, last);
      if (full) values.name = [{ first_name: first ?? "", last_name: last ?? "", full_name: full }];
    }
    if (s.email) values.email_addresses = [{ email_address: s.email }];
    if (s.phone) values.phone_numbers = [phoneValue(s.phone)];
    if (s.title) values.job_title = [{ value: s.title }];
    if (s.linkedinUrl) values.linkedin = [{ value: s.linkedinUrl }];
    if (w.tidemarkId && this.personTidemarkId) values.tidemark_id = [{ value: w.tidemarkId }];
    if (w.companyRemoteId) values.company = [{ target_object: "companies", target_record_id: w.companyRemoteId }];
    return values;
  }

  async writePeople(items: PersonWrite[]): Promise<WriteResult[]> {
    return mapLimit(items, WRITE_CONCURRENCY, async (w): Promise<WriteResult> => {
      const values = this.personValues(w);
      // New people: assert on email (dedupes against the CRM). Existing people:
      // PATCH, which appends emails/phones instead of replacing the CRM's list.
      const send = (vals: Record<string, unknown>) =>
        w.remoteId
          ? this.req<{ data: AttioRecord }>(`/objects/people/records/${encodeURIComponent(w.remoteId)}`, { method: "PATCH", json: { data: { values: vals } } })
          : this.req<{ data: AttioRecord }>("/objects/people/records?matching_attribute=email_addresses", { method: "PUT", json: { data: { values: vals } } });
      try {
        if (!Object.keys(values).length && w.remoteId) return { key: w.contactId, remoteId: w.remoteId };
        let warning: string | undefined;
        let res: { data: AttioRecord };
        try {
          res = await send(values);
        } catch (e) {
          if (!isPhoneRejection(e) || !values.phone_numbers) throw e;
          const rest = { ...values };
          delete rest.phone_numbers;
          warning = `phone not accepted by Attio: ${errMessage(e)}`;
          res = await send(rest);
        }
        const person = this.toPerson(res.data);
        return { key: w.contactId, remoteId: person.id, created: w.remoteId ? undefined : true, version: person.version, warning };
      } catch (e) {
        if (isAuthError(e)) throw e;
        return { key: w.contactId, error: errMessage(e) };
      }
    });
  }

  async personCompanyIds(remote: RemotePerson): Promise<string[]> {
    return remote.companyIds;
  }

  // ── lists ──

  async ensureList(list: { id: string; name: string }): Promise<string> {
    // Slug derives from the Tidemark list id so a reconnect finds the same list.
    const slug = `tidemark_${list.id.replace(/-/g, "").slice(0, 16)}`;
    const get = async () => (await this.req<{ data: AttioList }>(`/lists/${slug}`)).data.id.list_id;
    try {
      return await get();
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    try {
      const created = await this.req<{ data: AttioList }>("/lists", {
        method: "POST",
        json: {
          data: {
            name: crmListName(list.name),
            api_slug: slug,
            parent_object: "companies",
            workspace_access: "full-access",
            workspace_member_access: [],
          },
        },
      });
      return created.data.id.list_id;
    } catch (e) {
      if (isConflict(e)) return get();
      throw e;
    }
  }

  async addToList(remoteListId: string, companyRemoteIds: string[]): Promise<number> {
    const results = await mapLimit(companyRemoteIds, WRITE_CONCURRENCY, async (recordId) => {
      try {
        // Assert by parent: creates the entry or leaves the existing one as is.
        await this.req(`/lists/${encodeURIComponent(remoteListId)}/entries`, {
          method: "PUT",
          json: { data: { parent_record_id: recordId, parent_object: "companies", entry_values: {} } },
        });
        return 1;
      } catch (e) {
        if (isAuthError(e)) throw e;
        if (/multiple/i.test(errMessage(e))) return 0; // already on the list (more than once)
        throw e;
      }
    });
    return results.reduce<number>((a, b) => a + b, 0);
  }
}

export function createAttioAdapter(accessToken: string): CrmAdapter {
  return new AttioAdapter(accessToken);
}
