import { apiFetch, oauthRedirectUri, type RefreshFn } from "@/lib/integrations/connections";
import { serverEnv } from "@/lib/env";
import {
  COMPANY_PROPERTIES,
  PERSON_PROPERTIES,
  TIDEMARK_GROUP,
  chunk,
  crmListName,
  errMessage,
  httpStatus,
  isAuthError,
  isConflict,
  isNotFound,
  joinName,
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

// HubSpot: OAuth (v1 token endpoint), CRM v3 objects / search / properties,
// associations v4, Lists v3. Never issues DELETE.

const API = "https://api.hubapi.com";
const AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const COMPANY_OBJECT_TYPE_ID = "0-2";
const NATIVE_LINKEDIN_PROP = "hs_linkedin_url";
const CUSTOM_LINKEDIN_PROP = "tidemark_linkedin_url";

// Must match the scopes configured on the HubSpot app (Auth tab).
export const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.companies.read",
  "crm.schemas.companies.write",
  "crm.schemas.contacts.read",
  "crm.schemas.contacts.write",
  "crm.lists.read",
  "crm.lists.write",
];

// ── OAuth ────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = serverEnv.hubspotClientId();
  const clientSecret = serverEnv.hubspotClientSecret();
  if (!clientId || !clientSecret) throw new Error("HubSpot is not configured (HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET)");
  return { clientId, clientSecret };
}

export function hubspotAuthorizeUrl(state: string): string {
  const { clientId } = credentials();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", oauthRedirectUri("hubspot"));
  url.searchParams.set("scope", HUBSPOT_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

// NOTE: HubSpot has announced v1 of the OAuth API is deprecated on 2027-02-16;
// migrate these two calls to the v3 token API before then.
async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  return apiFetch<TokenResponse>(`${API}/oauth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

export async function exchangeHubspotCode(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = credentials();
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: oauthRedirectUri("hubspot"),
    code,
  });
}

export const refreshHubspotToken: RefreshFn = async (refreshToken) => {
  const { clientId, clientSecret } = credentials();
  return tokenRequest({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });
};

export interface HubspotTokenInfo {
  hub_id: number;
  hub_domain?: string;
  scopes?: string[];
  user?: string;
}

/** Which portal a token belongs to. */
export async function hubspotTokenInfo(accessToken: string): Promise<HubspotTokenInfo> {
  try {
    return await apiFetch<HubspotTokenInfo>(`${API}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`);
  } catch (e) {
    // apiFetch errors include the URL path, which here contains the token — never surface it.
    throw new Error(`HubSpot token lookup failed (${httpStatus(e) ?? "network error"})`);
  }
}

// ── API shapes ───────────────────────────────────────────────────────────────

interface HsHistoryEntry {
  value: string;
  timestamp: string;
}

interface HsObject {
  id: string;
  properties: Record<string, string | null>;
  // UNVERIFIED: propertiesWithHistory entries are read as {value, timestamp}.
  propertiesWithHistory?: Record<string, HsHistoryEntry[]>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

interface HsBatchResponse {
  status?: string;
  results: HsObject[];
  errors?: { message?: string }[];
}

interface HsProperty {
  name: string;
  type: string;
  fieldType: string;
  options?: { label: string; value: string; displayOrder?: number; hidden?: boolean }[];
}

interface HsList {
  listId: string | number;
  name?: string;
  processingType?: string;
  objectTypeId?: string;
}

const BATCH = 100;

function hsValue(v: FieldValue): string {
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
}

function effectiveType(p: HsProperty): FieldType {
  switch (p.type) {
    case "number":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "bool":
      return "boolean";
    case "enumeration":
      return p.fieldType === "booleancheckbox" ? "boolean" : "select";
    default:
      return p.fieldType === "textarea" ? "longtext" : "text";
  }
}

function propertyBody(p: PropertyDef): Record<string, unknown> {
  const base = { name: p.key, label: p.label, description: p.description, groupName: TIDEMARK_GROUP.name };
  switch (p.type) {
    case "longtext":
      return { ...base, type: "string", fieldType: "textarea" };
    case "number":
      return { ...base, type: "number", fieldType: "number" };
    case "date":
      return { ...base, type: "date", fieldType: "date" };
    case "boolean":
      return {
        ...base,
        type: "bool",
        fieldType: "booleancheckbox",
        options: [
          { label: "Yes", value: "true", displayOrder: 0 },
          { label: "No", value: "false", displayOrder: 1 },
        ],
      };
    case "select":
      return {
        ...base,
        type: "enumeration",
        fieldType: "select",
        options: (p.options ?? []).map((o, i) => ({ label: o.label, value: o.value, displayOrder: i })),
      };
    default: // text, url
      return { ...base, type: "string", fieldType: "text" };
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

class HubSpotAdapter implements CrmAdapter {
  readonly provider = "hubspot" as const;
  readonly label = "HubSpot";
  private available = new Map<string, FieldType>(); // company properties we may write
  private personAvailable = new Set<string>();
  private linkedinProp: string | null = null;

  constructor(private readonly token: string) {}

  private req<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    return apiFetch<T>(`${API}${path}`, { ...init, token: this.token });
  }

  // ── schema ──

  async ensureSchema(customColumns: PropertyDef[], opts: { syncOptions: boolean }): Promise<SchemaResult> {
    const errors: string[] = [];
    this.available = new Map();
    this.personAvailable = new Set();

    for (const object of ["companies", "contacts"] as const) {
      try {
        await this.ensureGroup(object);
      } catch (e) {
        if (isAuthError(e)) throw e;
        errors.push(`${object} property group: ${errMessage(e)}`);
      }
    }

    // Companies: Tidemark properties + custom columns.
    const companyExisting = await this.listProperties("companies");
    for (const def of [...COMPANY_PROPERTIES, ...customColumns]) {
      const type = await this.ensureProperty("companies", def, companyExisting, opts.syncOptions, errors);
      if (type) this.available.set(def.key, type);
    }

    // Contacts: tidemark_id, and a LinkedIn URL property (native when the portal has it).
    const contactExisting = await this.listProperties("contacts");
    const personDefs = [...PERSON_PROPERTIES];
    if (contactExisting.has(NATIVE_LINKEDIN_PROP)) {
      this.linkedinProp = NATIVE_LINKEDIN_PROP;
    } else {
      this.linkedinProp = CUSTOM_LINKEDIN_PROP;
      personDefs.push({ key: CUSTOM_LINKEDIN_PROP, label: "LinkedIn URL", description: "LinkedIn profile (synced by Tidemark)", type: "url" });
    }
    for (const def of personDefs) {
      const type = await this.ensureProperty("contacts", def, contactExisting, opts.syncOptions, errors);
      if (type) this.personAvailable.add(def.key);
    }
    return { available: new Map(this.available), errors };
  }

  // UNVERIFIED: property-group endpoints (GET/POST /crm/v3/properties/{objectType}/groups[/{name}]).
  private async ensureGroup(object: "companies" | "contacts") {
    try {
      await this.req(`/crm/v3/properties/${object}/groups/${TIDEMARK_GROUP.name}`);
      return;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    try {
      await this.req(`/crm/v3/properties/${object}/groups`, {
        method: "POST",
        json: { name: TIDEMARK_GROUP.name, label: TIDEMARK_GROUP.label, displayOrder: -1 },
      });
    } catch (e) {
      if (!isConflict(e)) throw e;
    }
  }

  private async listProperties(object: "companies" | "contacts"): Promise<Map<string, HsProperty>> {
    const res = await this.req<{ results: HsProperty[] }>(`/crm/v3/properties/${object}`);
    return new Map(res.results.map((p) => [p.name, p]));
  }

  private async ensureProperty(
    object: "companies" | "contacts",
    def: PropertyDef,
    existing: Map<string, HsProperty>,
    syncOptions: boolean,
    errors: string[],
  ): Promise<FieldType | null> {
    const found = existing.get(def.key);
    if (!found) {
      try {
        const created = await this.req<HsProperty>(`/crm/v3/properties/${object}`, { method: "POST", json: propertyBody(def) });
        return effectiveType(created);
      } catch (e) {
        if (isAuthError(e)) throw e;
        if (isConflict(e)) return def.type; // created concurrently
        errors.push(`${object}.${def.key}: ${errMessage(e)}`);
        return null;
      }
    }
    const type = effectiveType(found);
    if (syncOptions && type === "select" && def.type === "select" && def.options?.length) {
      const have = new Set((found.options ?? []).map((o) => o.value));
      const missing = def.options.filter((o) => !have.has(o.value));
      if (missing.length) {
        const options = [...(found.options ?? []), ...missing.map((o) => ({ label: o.label, value: o.value }))].map((o, i) => ({
          label: o.label,
          value: o.value,
          displayOrder: i,
        }));
        try {
          // UNVERIFIED: PATCH /crm/v3/properties/{objectType}/{propertyName} with the full options list.
          await this.req(`/crm/v3/properties/${object}/${encodeURIComponent(def.key)}`, { method: "PATCH", json: { options } });
        } catch (e) {
          if (isAuthError(e)) throw e;
          errors.push(`${object}.${def.key} options: ${errMessage(e)}`);
        }
      }
    }
    return type;
  }

  private async getLinkedinProp(): Promise<string> {
    if (this.linkedinProp) return this.linkedinProp;
    try {
      await this.req(`/crm/v3/properties/contacts/${NATIVE_LINKEDIN_PROP}`);
      this.linkedinProp = NATIVE_LINKEDIN_PROP;
    } catch (e) {
      if (!isNotFound(e)) throw e;
      this.linkedinProp = CUSTOM_LINKEDIN_PROP;
    }
    return this.linkedinProp;
  }

  // ── companies ──

  private async search(object: "companies" | "contacts", propertyName: string, values: string[], properties: string[]): Promise<HsObject[]> {
    const out: HsObject[] = [];
    for (const group of chunk(values, BATCH)) {
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await this.req<{ results: HsObject[]; paging?: { next?: { after: string } } }>(`/crm/v3/objects/${object}/search`, {
          method: "POST",
          json: {
            // IN on string properties needs lowercase values (HubSpot search docs).
            filterGroups: [{ filters: [{ propertyName, operator: "IN", values: group.map((v) => v.toLowerCase()) }] }],
            properties,
            limit: 200,
            ...(after ? { after } : {}),
          },
        });
        out.push(...res.results);
        after = res.paging?.next?.after;
        if (!after) break;
      }
    }
    // Oldest first so the original record wins over later duplicates.
    return out.sort((a, b) => (parseTs(a.createdAt) ?? 0) - (parseTs(b.createdAt) ?? 0));
  }

  private toCompany(o: HsObject): RemoteCompany {
    return {
      id: o.id,
      name: o.properties.name ?? null,
      domain: normalizeDomain(o.properties.domain),
      tidemarkId: o.properties.tidemark_id ?? null,
    };
  }

  async findCompanies(q: { tidemarkIds: string[]; domains: string[] }) {
    const byTidemarkId = new Map<string, RemoteCompany>();
    const byDomain = new Map<string, RemoteCompany>();
    const props = ["name", "domain", "tidemark_id"];
    if (q.tidemarkIds.length && this.available.has("tidemark_id")) {
      for (const o of await this.search("companies", "tidemark_id", q.tidemarkIds, props)) {
        const c = this.toCompany(o);
        if (c.tidemarkId && !byTidemarkId.has(c.tidemarkId)) byTidemarkId.set(c.tidemarkId, c);
      }
    }
    if (q.domains.length) {
      for (const o of await this.search("companies", "domain", q.domains, props)) {
        const c = this.toCompany(o);
        if (c.domain && !byDomain.has(c.domain)) byDomain.set(c.domain, c);
      }
    }
    return { byTidemarkId, byDomain };
  }

  private companyProps(item: CompanyWrite, create: boolean): Record<string, string> {
    const props: Record<string, string> = {};
    for (const [k, v] of Object.entries(item.fields)) if (this.available.has(k)) props[k] = hsValue(v);
    if (create) {
      props.name = item.name;
      if (item.domain) props.domain = item.domain;
    }
    return props;
  }

  async writeCompanies(items: CompanyWrite[]): Promise<WriteResult[]> {
    const out: WriteResult[] = [];
    const creates = items.filter((i) => !i.remoteId);
    const updates = items.filter((i) => i.remoteId);
    // Batch results are matched back through tidemark_id; without it, create one by one.
    const canBatchCreate = this.available.has("tidemark_id");

    for (const group of chunk(creates, BATCH)) {
      const inputs = group.map((i) => ({ properties: this.companyProps(i, true), associations: [] }));
      let done = false;
      if (canBatchCreate && group.length > 1) {
        try {
          const res = await this.req<HsBatchResponse>("/crm/v3/objects/companies/batch/create", { method: "POST", json: { inputs } });
          const byTid = new Map(res.results.map((r) => [r.properties.tidemark_id ?? "", r]));
          for (const i of group) {
            const r = byTid.get(i.accountId);
            out.push(r ? { key: i.accountId, remoteId: r.id, created: true } : { key: i.accountId, error: res.errors?.[0]?.message ?? "not created" });
          }
          done = true;
        } catch (e) {
          if (isAuthError(e)) throw e; // otherwise retry one by one to isolate the bad record
        }
      }
      if (!done) {
        for (const [n, i] of group.entries()) {
          try {
            const r = await this.req<HsObject>("/crm/v3/objects/companies", { method: "POST", json: inputs[n] });
            out.push({ key: i.accountId, remoteId: r.id, created: true });
          } catch (e) {
            if (isAuthError(e)) throw e;
            out.push({ key: i.accountId, error: errMessage(e) });
          }
        }
      }
    }

    for (const group of chunk(updates, BATCH)) {
      out.push(...(await this.batchUpdate("companies", group.map((i) => ({ key: i.accountId, id: i.remoteId!, properties: this.companyProps(i, false) })))));
    }
    return out;
  }

  private async batchUpdate(object: "companies" | "contacts", rows: { key: string; id: string; properties: Record<string, string> }[]): Promise<WriteResult[]> {
    const out: WriteResult[] = [];
    const todo = rows.filter((r) => Object.keys(r.properties).length > 0);
    for (const r of rows) if (!Object.keys(r.properties).length) out.push({ key: r.key, remoteId: r.id });
    if (!todo.length) return out;
    if (todo.length > 1) {
      try {
        const res = await this.req<HsBatchResponse>(`/crm/v3/objects/${object}/batch/update`, {
          method: "POST",
          json: { inputs: todo.map((r) => ({ id: r.id, properties: r.properties })) },
        });
        const byId = new Map(res.results.map((o) => [o.id, o]));
        for (const r of todo) {
          const o = byId.get(r.id);
          out.push(o ? { key: r.key, remoteId: o.id, version: parseTs(o.updatedAt) } : { key: r.key, error: res.errors?.[0]?.message ?? "not updated" });
        }
        return out;
      } catch (e) {
        if (isAuthError(e)) throw e;
      }
    }
    for (const r of todo) {
      try {
        const o = await this.req<HsObject>(`/crm/v3/objects/${object}/${encodeURIComponent(r.id)}`, { method: "PATCH", json: { properties: r.properties } });
        out.push({ key: r.key, remoteId: o.id, version: parseTs(o.updatedAt) });
      } catch (e) {
        if (isAuthError(e)) throw e;
        out.push({ key: r.key, error: errMessage(e) });
      }
    }
    return out;
  }

  async getCompanies(ids: string[]): Promise<RemoteCompany[]> {
    const out: RemoteCompany[] = [];
    for (const group of chunk(ids, BATCH)) {
      const res = await this.req<HsBatchResponse>("/crm/v3/objects/companies/batch/read", {
        method: "POST",
        json: { inputs: group.map((id) => ({ id })), properties: ["name", "domain", "tidemark_id"] },
      });
      out.push(...res.results.map((o) => this.toCompany(o)));
    }
    return out;
  }

  // ── people ──

  private async personProps(): Promise<{ read: string[]; history: string[] }> {
    const li = await this.getLinkedinProp();
    const history = ["firstname", "lastname", "email", "jobtitle", "phone", li];
    return { read: [...history, "hs_additional_emails", "tidemark_id"], history };
  }

  private async toPerson(o: HsObject): Promise<RemotePerson> {
    const li = await this.getLinkedinProp();
    const p = o.properties;
    const ts = (prop: string): number | null => {
      const h = o.propertiesWithHistory?.[prop];
      return h?.length ? maxTs(...h.map((e) => parseTs(e.timestamp))) : null;
    };
    const fieldTs = {
      name: maxTs(ts("firstname"), ts("lastname")) ?? undefined,
      email: ts("email") ?? undefined,
      title: ts("jobtitle") ?? undefined,
      phone: ts("phone") ?? undefined,
      linkedin: ts(li) ?? undefined,
    };
    const email = p.email?.trim().toLowerCase() || null;
    const extra = (p.hs_additional_emails ?? "")
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const values: PersonValues = {
      firstName: p.firstname?.trim() || null,
      lastName: p.lastname?.trim() || null,
      fullName: joinName(p.firstname?.trim() || null, p.lastname?.trim() || null),
      email,
      title: p.jobtitle?.trim() || null,
      phone: p.phone?.trim() || null,
      linkedinUrl: p[li]?.trim() || null,
    };
    return {
      id: o.id,
      values,
      emails: [...(email ? [email] : []), ...extra],
      phones: values.phone ? [values.phone] : [],
      fieldTs,
      version: maxTs(...Object.values(fieldTs)),
      companyIds: [], // not returned by batch read; see personCompanyIds()
      tidemarkId: p.tidemark_id ?? null,
    };
  }

  private async batchRead(ids: string[], idProperty?: "email"): Promise<HsObject[]> {
    const { read, history } = await this.personProps();
    const out: HsObject[] = [];
    for (const group of chunk(ids, BATCH)) {
      try {
        const res = await this.req<HsBatchResponse>("/crm/v3/objects/contacts/batch/read", {
          method: "POST",
          json: {
            ...(idProperty ? { idProperty } : {}),
            inputs: group.map((id) => ({ id })),
            properties: read,
            propertiesWithHistory: history,
          },
        });
        out.push(...res.results.filter((o) => !o.archived));
      } catch (e) {
        if (!isNotFound(e)) throw e; // none of the ids exist
      }
    }
    return out;
  }

  async findPeopleByEmail(emails: string[]): Promise<Map<string, RemotePerson>> {
    const wanted = new Set(emails.map((e) => e.toLowerCase()));
    const out = new Map<string, RemotePerson>();
    for (const o of await this.batchRead([...wanted], "email")) {
      const person = await this.toPerson(o);
      for (const e of person.emails) if (wanted.has(e) && !out.has(e)) out.set(e, person);
    }
    return out;
  }

  async getPeople(ids: string[]): Promise<Map<string, RemotePerson>> {
    const out = new Map<string, RemotePerson>();
    for (const o of await this.batchRead(ids)) out.set(o.id, await this.toPerson(o));
    return out;
  }

  private async contactProps(w: PersonWrite): Promise<Record<string, string>> {
    const li = await this.getLinkedinProp();
    const s = w.set;
    const props: Record<string, string> = {};
    if (s.firstName !== undefined || s.lastName !== undefined || s.fullName !== undefined) {
      const split = splitName(s.fullName ?? null);
      const first = s.firstName ?? split.first;
      const last = s.lastName ?? split.last;
      if (first) props.firstname = first;
      if (last) props.lastname = last;
    }
    if (s.email) props.email = s.email;
    if (s.title) props.jobtitle = s.title;
    if (s.phone) props.phone = s.phone;
    if (s.linkedinUrl && (li === NATIVE_LINKEDIN_PROP || this.personAvailable.has(li))) props[li] = s.linkedinUrl;
    if (w.tidemarkId && this.personAvailable.has("tidemark_id")) props.tidemark_id = w.tidemarkId;
    return props;
  }

  async writePeople(items: PersonWrite[]): Promise<WriteResult[]> {
    const out: WriteResult[] = [];
    const creates = items.filter((i) => !i.remoteId);
    const updates = items.filter((i) => i.remoteId);

    for (const group of chunk(creates, BATCH)) {
      const inputs = await Promise.all(group.map(async (i) => ({ properties: await this.contactProps(i), associations: [] })));
      let done = false;
      if (group.length > 1) {
        try {
          const res = await this.req<HsBatchResponse>("/crm/v3/objects/contacts/batch/create", { method: "POST", json: { inputs } });
          const byEmail = new Map(res.results.map((r) => [(r.properties.email ?? "").toLowerCase(), r]));
          for (const i of group) {
            const r = byEmail.get((i.set.email ?? "").toLowerCase());
            out.push(
              r
                ? { key: i.contactId, remoteId: r.id, created: true, version: parseTs(r.updatedAt) }
                : { key: i.contactId, error: res.errors?.[0]?.message ?? "not created" },
            );
          }
          done = true;
        } catch (e) {
          if (isAuthError(e)) throw e;
        }
      }
      if (!done) {
        for (const [n, i] of group.entries()) {
          try {
            const r = await this.req<HsObject>("/crm/v3/objects/contacts", { method: "POST", json: inputs[n] });
            out.push({ key: i.contactId, remoteId: r.id, created: true, version: parseTs(r.updatedAt) });
          } catch (e) {
            if (isAuthError(e)) throw e;
            out.push({ key: i.contactId, error: errMessage(e) });
          }
        }
      }
    }

    for (const group of chunk(updates, BATCH)) {
      const rows = await Promise.all(group.map(async (i) => ({ key: i.contactId, id: i.remoteId!, properties: await this.contactProps(i) })));
      out.push(...(await this.batchUpdate("contacts", rows)));
    }

    // Associate contact → company (default/unlabeled association).
    const byKey = new Map(out.map((r) => [r.key, r]));
    const pairs = items
      .filter((i) => i.companyRemoteId && byKey.get(i.contactId)?.remoteId)
      .map((i) => ({ key: i.contactId, from: byKey.get(i.contactId)!.remoteId!, to: i.companyRemoteId! }));
    for (const group of chunk(pairs, BATCH)) {
      try {
        await this.req("/crm/v4/associations/contact/company/batch/associate/default", {
          method: "POST",
          json: { inputs: group.map((p) => ({ from: { id: p.from }, to: { id: p.to } })) },
        });
      } catch (e) {
        if (isAuthError(e)) throw e;
        for (const p of group) byKey.get(p.key)!.warning = `associate with company: ${errMessage(e)}`;
      }
    }
    return out;
  }

  async personCompanyIds(remote: RemotePerson): Promise<string[]> {
    // UNVERIFIED: GET /crm/v4/objects/{fromObjectType}/{id}/associations/{toObjectType} → results[].toObjectId
    const res = await this.req<{ results: { toObjectId: number | string }[] }>(
      `/crm/v4/objects/contact/${encodeURIComponent(remote.id)}/associations/company`,
    );
    return res.results.map((r) => String(r.toObjectId));
  }

  // ── lists ──

  async ensureList(list: { id: string; name: string }): Promise<string> {
    const name = crmListName(list.name);
    try {
      const found = await this.req<{ list: HsList }>(`/crm/v3/lists/object-type-id/${COMPANY_OBJECT_TYPE_ID}/name/${encodeURIComponent(name)}`);
      return String(found.list.listId);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const created = await this.req<{ list: HsList }>("/crm/v3/lists", {
      method: "POST",
      json: { name, objectTypeId: COMPANY_OBJECT_TYPE_ID, processingType: "MANUAL" },
    });
    return String(created.list.listId);
  }

  async addToList(remoteListId: string, companyRemoteIds: string[]): Promise<number> {
    let added = 0;
    for (const group of chunk(companyRemoteIds, BATCH)) {
      const res = await this.req<{ recordIdsAdded?: string[] }>(`/crm/v3/lists/${encodeURIComponent(remoteListId)}/memberships/add`, {
        method: "PUT",
        json: group,
      });
      added += res?.recordIdsAdded?.length ?? 0;
    }
    return added;
  }
}

export function createHubspotAdapter(accessToken: string): CrmAdapter {
  return new HubSpotAdapter(accessToken);
}
