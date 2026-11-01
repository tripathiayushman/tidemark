import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandlerTable } from "@/lib/worker/handlers";
import { enqueue } from "@/lib/jobs";
import { publicEnv } from "@/lib/env";
import { getAccessToken, getConnection, markError, markSynced, type ConnectionRow } from "@/lib/integrations/connections";
import { createHubspotAdapter, refreshHubspotToken } from "./hubspot";
import { createAttioAdapter } from "./attio";
import {
  COMPANY_PROPERTIES,
  CRM_LABEL,
  PERSON_FIELDS,
  chunk,
  companyFieldValues,
  customColumnProperty,
  decideField,
  errMessage,
  isAuthError,
  isCrmProvider,
  localPersonValues,
  maxTs,
  normalizeDomain,
  parseTs,
  pullPatch,
  pushPatch,
  schemaKey,
  toFieldValue,
  type CompanyWrite,
  type CrmAdapter,
  type CrmProvider,
  type CustomColumnRow,
  type FieldType,
  type FieldValue,
  type PersonValues,
  type PersonWrite,
  type PropertyDef,
  type RemotePerson,
} from "./shared";

// CRM sync engine (HubSpot + Attio) on top of the provider adapters.
//
//   crm.push  schema → qualified accounts → their contacts → lists
//   crm.pull  schema → reconcile every linked person (CRM edits to name,
//             email, job title, phone, LinkedIn come back) → incremental push
//
// Rules: never deletes anything in the CRM; people who exist only in the CRM
// stay out of Tidemark unless importPersonFromCrm() is called for them; one
// sync per connection at a time (lease in sync_cursor.lock_until); each run is
// time-boxed and continues in a follow-up job, so dirty tracking lives on
// each crm_links row (last_pushed_at) rather than only on a global cursor.

const BUDGET_MS = 30_000; // the worker's HTTP tick is capped at 60s
const LOCK_MS = 5 * 60_000;
const ACCOUNT_CHUNK = 50;
const PEOPLE_CHUNK = 100;
const LIST_CHUNK = 100;
const CLOCK_MARGIN_MS = 60_000;

type Mode = "push" | "pull";
type LinkType = "company" | "person" | "list" | "property";

interface LinkRow {
  local_id: string;
  remote_id: string;
  remote_updated_at: string | null;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
  created_at?: string;
}

interface CrmCursor {
  last_push_at?: string;
  schema_key?: string;
  lock_until?: string;
  last_run?: Record<string, unknown>;
  [k: string]: unknown;
}

interface AccountRow {
  id: string;
  updated_at: string;
  tier: string | null;
  score: number | null;
  reason_to_buy: string | null;
  why: string | null;
  timing_label: string | null;
  contact_window_start: string | null;
  contact_window_end: string | null;
  companies: { name: string; domain: string | null; website: string | null } | null;
}

interface ContactRow {
  id: string;
  account_id: string | null;
  company_id: string | null;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  updated_at: string;
}

const ACCOUNT_COLS =
  "id, updated_at, tier, score, reason_to_buy, why, timing_label, contact_window_start, contact_window_end, companies(name, domain, website)";
const CONTACT_COLS = "id, account_id, company_id, full_name, first_name, last_name, title, email, phone, linkedin_url, updated_at";
const LINK_COLS = "local_id, remote_id, remote_updated_at, last_pushed_at, last_pulled_at, created_at";

type QueryResult = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

async function fetchAll<T>(build: (from: number, to: number) => QueryResult): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) break;
  }
  return out;
}

async function adapterFor(db: SupabaseClient, conn: ConnectionRow): Promise<CrmAdapter> {
  if (conn.provider === "hubspot") return createHubspotAdapter(await getAccessToken(db, conn.id, refreshHubspotToken));
  if (conn.provider === "attio") return createAttioAdapter(await getAccessToken(db, conn.id));
  throw new Error(`Connection ${conn.id} is not a CRM connection (${conn.provider})`);
}

// ── Lease: one sync per connection ───────────────────────────────────────────

type Lease = { state: "gone" } | { state: "locked"; conn: ConnectionRow } | { state: "ok"; conn: ConnectionRow; cursor: CrmCursor };

async function acquireLease(db: SupabaseClient, connectionId: string): Promise<Lease> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db.from("integration_connections").select("*").eq("id", connectionId).maybeSingle();
    if (error) throw new Error(`load connection: ${error.message}`);
    if (!data) return { state: "gone" };
    const row = data as ConnectionRow & { updated_at: string };
    if (row.status === "disconnected") return { state: "gone" };
    const cursor = (row.sync_cursor ?? {}) as CrmCursor;
    const now = Date.now();
    if (cursor.lock_until && Date.parse(cursor.lock_until) > now) return { state: "locked", conn: row };
    const next: CrmCursor = { ...cursor, lock_until: new Date(now + LOCK_MS).toISOString() };
    // Compare-and-swap on updated_at (bumped by the touch trigger on every write).
    const { data: won, error: e2 } = await db
      .from("integration_connections")
      .update({ sync_cursor: next })
      .eq("id", connectionId)
      .eq("updated_at", row.updated_at)
      .select("id");
    if (e2) throw new Error(`lock connection: ${e2.message}`);
    if (won?.length) return { state: "ok", conn: { ...row, sync_cursor: next }, cursor: next };
  }
  return { state: "locked", conn: await getConnection(db, connectionId) };
}

function withoutLock(c: CrmCursor): CrmCursor {
  const next = { ...c };
  delete next.lock_until;
  return next;
}

// ── One sync run ─────────────────────────────────────────────────────────────

interface Stats {
  companiesCreated: number;
  companiesLinked: number;
  companiesUpdated: number;
  peopleCreated: number;
  peopleLinked: number;
  peopleUpdated: number;
  peoplePulled: number;
  peopleMissingInCrm: number;
  listsLinked: number;
  listMembersAdded: number;
  errors: number;
  warnings: number;
}

class SyncRun {
  readonly stats: Stats = {
    companiesCreated: 0,
    companiesLinked: 0,
    companiesUpdated: 0,
    peopleCreated: 0,
    peopleLinked: 0,
    peopleUpdated: 0,
    peoplePulled: 0,
    peopleMissingInCrm: 0,
    listsLinked: 0,
    listMembersAdded: 0,
    errors: 0,
    warnings: 0,
  };
  readonly messages: string[] = [];
  truncated = false;
  schemaKey: string | undefined;

  private readonly started = Date.now();
  private readonly runAt = new Date().toISOString(); // data read after this is "seen"
  private readonly ws: string;
  private readonly appUrl = publicEnv.appUrl();
  private readonly accountIdSet: Set<string> | null;
  private available = new Map<string, FieldType>();
  private columnDefs: PropertyDef[] = [];
  private companyLinks = new Map<string, LinkRow>();
  private companyOwner = new Map<string, string>(); // remote id → account id
  private personLinks = new Map<string, LinkRow>();
  private personOwner = new Map<string, string>(); // remote id → contact id
  private newlyLinkedAccounts = new Set<string>();
  private handledContacts = new Set<string>();

  constructor(
    private readonly db: SupabaseClient,
    private readonly conn: ConnectionRow,
    private readonly adapter: CrmAdapter,
    private readonly cursor: CrmCursor,
    accountIds?: string[],
  ) {
    this.ws = conn.workspace_id;
    this.accountIdSet = accountIds?.length ? new Set(accountIds) : null;
  }

  get runStartedAt() {
    return this.runAt;
  }

  private timeUp(fraction = 1): boolean {
    const over = Date.now() - this.started > BUDGET_MS * fraction;
    if (over && fraction >= 1) this.truncated = true;
    return over;
  }

  private problem(context: string, e: unknown) {
    if (isAuthError(e)) throw e;
    this.stats.errors++;
    if (this.messages.length < 10) this.messages.push(`${context}: ${errMessage(e)}`.slice(0, 300));
  }

  private warn(context: string, message: string) {
    this.stats.warnings++;
    if (this.messages.length < 10) this.messages.push(`${context}: ${message}`.slice(0, 300));
  }

  // ── links ──

  private async loadLinks(type: LinkType): Promise<Map<string, LinkRow>> {
    const rows = await fetchAll<LinkRow & { local_id: string | null }>((from, to) =>
      this.db
        .from("crm_links")
        .select(LINK_COLS)
        .eq("connection_id", this.conn.id)
        .eq("object_type", type)
        .order("id")
        .range(from, to),
    );
    return new Map(rows.filter((r) => r.local_id).map((r) => [r.local_id as string, r as LinkRow]));
  }

  /** Upsert full link rows (every column given, so bulk upserts never null out values). */
  private async saveLinks(type: LinkType, rows: LinkRow[]) {
    if (!rows.length) return;
    const payload = (rs: LinkRow[]) =>
      rs.map((r) => ({
        workspace_id: this.ws,
        connection_id: this.conn.id,
        object_type: type,
        local_id: r.local_id,
        remote_id: r.remote_id,
        remote_updated_at: r.remote_updated_at,
        last_pushed_at: r.last_pushed_at,
        last_pulled_at: r.last_pulled_at,
      }));
    const { error } = await this.db.from("crm_links").upsert(payload(rows), { onConflict: "connection_id,object_type,local_id" });
    if (!error) return this.rememberLinks(type, rows);
    // Isolate the offending row (e.g. two local records claiming one CRM record).
    for (const r of rows) {
      const { error: e } = await this.db.from("crm_links").upsert(payload([r]), { onConflict: "connection_id,object_type,local_id" });
      if (e) this.problem(`link ${type} ${r.local_id}`, e.message);
      else this.rememberLinks(type, [r]);
    }
  }

  private rememberLinks(type: LinkType, rows: LinkRow[]) {
    for (const r of rows) {
      if (type === "company") {
        this.companyLinks.set(r.local_id, { ...r, created_at: this.companyLinks.get(r.local_id)?.created_at ?? new Date().toISOString() });
        this.companyOwner.set(r.remote_id, r.local_id);
      } else if (type === "person") {
        this.personLinks.set(r.local_id, r);
        this.personOwner.set(r.remote_id, r.local_id);
      }
    }
  }

  async loadState() {
    this.companyLinks = await this.loadLinks("company");
    this.personLinks = await this.loadLinks("person");
    for (const [local, l] of this.companyLinks) this.companyOwner.set(l.remote_id, local);
    for (const [local, l] of this.personLinks) this.personOwner.set(l.remote_id, local);
  }

  // ── schema ──

  async schema() {
    const { data, error } = await this.db
      .from("custom_columns")
      .select("id, name, key, data_type, options")
      .eq("workspace_id", this.ws)
      .order("position");
    if (error) throw new Error(`custom columns: ${error.message}`);
    const columns = ((data ?? []) as CustomColumnRow[]).map(customColumnProperty);
    const key = schemaKey([...COMPANY_PROPERTIES, ...columns]);
    const changed = key !== this.cursor.schema_key;
    let res: Awaited<ReturnType<CrmAdapter["ensureSchema"]>>;
    try {
      res = await this.adapter.ensureSchema(columns, { syncOptions: changed });
    } catch (e) {
      // e.g. a missing schema scope: still sync names/domains/people, just
      // without Tidemark properties, and retry provisioning next run.
      this.problem("schema", e);
      this.available = new Map();
      this.columnDefs = [];
      this.schemaKey = this.cursor.schema_key;
      return;
    }
    for (const m of res.errors) this.problem("schema", m);
    this.available = res.available;
    this.columnDefs = columns.filter((c) => res.available.has(c.key));
    // Retry option sync next run if anything failed.
    this.schemaKey = res.errors.length ? this.cursor.schema_key : key;
    if (changed && this.columnDefs.length) {
      await this.saveLinks(
        "property",
        this.columnDefs.map((c) => ({
          local_id: c.columnId!,
          remote_id: c.key,
          remote_updated_at: null,
          last_pushed_at: this.runAt,
          last_pulled_at: null,
        })),
      );
    }
  }

  // ── people: shared pieces ──

  private async loadContacts(ids: string[]): Promise<Map<string, ContactRow>> {
    const out = new Map<string, ContactRow>();
    for (const group of chunk(ids, 100)) {
      const { data, error } = await this.db.from("contacts").select(CONTACT_COLS).eq("workspace_id", this.ws).in("id", group);
      if (error) throw new Error(`contacts: ${error.message}`);
      for (const c of (data ?? []) as ContactRow[]) out.set(c.id, c);
    }
    return out;
  }

  /** Apply pulled values locally; returns the new updated_at. */
  private async updateContact(c: ContactRow, patch: Record<string, string | null>): Promise<string | null> {
    let { data, error } = await this.db.from("contacts").update(patch).eq("id", c.id).select("updated_at").maybeSingle();
    if (error?.code === "23505" && "email" in patch) {
      // Another Tidemark contact already has that email — keep ours.
      this.warn(`contact ${c.id}`, `CRM email ${patch.email} already belongs to another contact; email not copied`);
      const rest = { ...patch };
      delete rest.email;
      if (!Object.keys(rest).length) return null;
      ({ data, error } = await this.db.from("contacts").update(rest).eq("id", c.id).select("updated_at").maybeSingle());
    }
    if (error) {
      this.problem(`update contact ${c.id}`, error.message);
      return null;
    }
    return (data as { updated_at: string } | null)?.updated_at ?? null;
  }

  private seenAt(localUpdatedAt: string | null): string {
    const t = maxTs(parseTs(this.runAt), parseTs(localUpdatedAt));
    return new Date(t ?? Date.now()).toISOString();
  }

  /** Two-way merge for people already linked to a CRM record. */
  private async reconcile(items: { contact: ContactRow; link: LinkRow }[]) {
    if (!items.length) return;
    const remote = await this.adapter.getPeople(items.map((i) => i.link.remote_id));
    const writes: PersonWrite[] = [];
    const pending: { contact: ContactRow; link: LinkRow; version: number | null; localUpdatedAt: string; pushing: boolean }[] = [];
    const now = new Date().toISOString();

    for (const { contact, link } of items) {
      this.handledContacts.add(contact.id);
      const r = remote.get(link.remote_id);
      if (!r) {
        // Deleted or merged away in the CRM. We never recreate it.
        this.stats.peopleMissingInCrm++;
        continue;
      }
      const local = localPersonValues(contact);
      const lastSeen = parseTs(link.remote_updated_at) ?? parseTs(link.last_pulled_at);
      const localDirty = !link.last_pushed_at || Date.parse(contact.updated_at) > Date.parse(link.last_pushed_at);
      const localPatch: Record<string, string | null> = {};
      const set: Partial<PersonValues> = {};
      for (const f of PERSON_FIELDS) {
        const d = decideField(f, local, r, { firstLink: false, lastSeen, localDirty });
        if (d === "pull") Object.assign(localPatch, pullPatch(f, r.values));
        else if (d === "push") Object.assign(set, pushPatch(f, local));
      }
      let localUpdatedAt = contact.updated_at;
      if (Object.keys(localPatch).length) {
        const ts = await this.updateContact(contact, localPatch);
        if (ts) {
          localUpdatedAt = ts;
          this.stats.peoplePulled++;
        }
      }
      const pushing = Object.keys(set).length > 0;
      if (pushing || r.tidemarkId !== contact.id) writes.push({ contactId: contact.id, remoteId: r.id, set, tidemarkId: contact.id });
      pending.push({ contact, link, version: r.version, localUpdatedAt, pushing });
    }

    const results = new Map((writes.length ? await this.adapter.writePeople(writes) : []).map((w) => [w.key, w]));
    const links: LinkRow[] = [];
    for (const p of pending) {
      const res = results.get(p.contact.id);
      if (res?.warning) this.warn(`person ${p.contact.id}`, res.warning);
      if (res?.error) {
        this.problem(`update person ${p.contact.id}`, res.error);
        // Leave last_pushed_at so the local change is retried.
        links.push({ ...p.link, remote_updated_at: tsIso(p.version) ?? p.link.remote_updated_at, last_pulled_at: now });
        continue;
      }
      if (res && p.pushing) this.stats.peopleUpdated++;
      links.push({
        local_id: p.contact.id,
        remote_id: p.link.remote_id,
        remote_updated_at: tsIso(maxTs(res?.version, p.version)) ?? p.link.remote_updated_at,
        last_pushed_at: this.seenAt(p.localUpdatedAt),
        last_pulled_at: now,
      });
    }
    await this.saveLinks("person", links);
  }

  /** People not yet linked: match an existing CRM person by email, else create. */
  private async linkOrCreate(contacts: ContactRow[]) {
    if (!contacts.length) return;
    const existing = await this.adapter.findPeopleByEmail(contacts.map((c) => c.email!.toLowerCase()));
    const writes: PersonWrite[] = [];
    const meta = new Map<string, { remote: RemotePerson | null; localUpdatedAt: string }>();

    for (const c of contacts) {
      this.handledContacts.add(c.id);
      const local = localPersonValues(c);
      const companyRemoteId = c.account_id ? (this.companyLinks.get(c.account_id)?.remote_id ?? null) : null;
      const r = existing.get(local.email!);
      if (!r) {
        const set: Partial<PersonValues> = {};
        for (const f of PERSON_FIELDS) Object.assign(set, pushPatch(f, local));
        writes.push({ contactId: c.id, remoteId: null, set, tidemarkId: c.id, companyRemoteId });
        meta.set(c.id, { remote: null, localUpdatedAt: c.updated_at });
        continue;
      }
      const owner = this.personOwner.get(r.id);
      if (owner && owner !== c.id) {
        this.warn(`contact ${c.id}`, `same ${this.adapter.label} person as contact ${owner}; not linked`);
        continue;
      }
      // First link of a person the CRM already had: CRM wins conflicts,
      // Tidemark only fills the CRM's blanks.
      const localPatch: Record<string, string | null> = {};
      const set: Partial<PersonValues> = {};
      for (const f of PERSON_FIELDS) {
        const d = decideField(f, local, r, { firstLink: true, lastSeen: null, localDirty: true });
        if (d === "pull") Object.assign(localPatch, pullPatch(f, r.values));
        else if (d === "push") Object.assign(set, pushPatch(f, local));
      }
      let localUpdatedAt = c.updated_at;
      if (Object.keys(localPatch).length) {
        const ts = await this.updateContact(c, localPatch);
        if (ts) {
          localUpdatedAt = ts;
          this.stats.peoplePulled++;
        }
      }
      writes.push({
        contactId: c.id,
        remoteId: r.id,
        set,
        tidemarkId: c.id,
        // Attio holds one company per person: only fill it when empty.
        companyRemoteId: r.companyIds.length ? null : companyRemoteId,
      });
      meta.set(c.id, { remote: r, localUpdatedAt });
    }

    const results = writes.length ? await this.adapter.writePeople(writes) : [];
    const now = new Date().toISOString();
    const links: LinkRow[] = [];
    for (const res of results) {
      const m = meta.get(res.key);
      if (!m) continue;
      if (res.warning) this.warn(`person ${res.key}`, res.warning);
      if (res.error || !res.remoteId) {
        this.problem(`${m.remote ? "link" : "create"} person ${res.key}`, res.error ?? "no id returned");
        continue;
      }
      if (m.remote) this.stats.peopleLinked++;
      else this.stats.peopleCreated++;
      links.push({
        local_id: res.key,
        remote_id: res.remoteId,
        remote_updated_at: tsIso(maxTs(res.version, m.remote?.version)),
        last_pushed_at: this.seenAt(m.localUpdatedAt),
        last_pulled_at: now,
      });
    }
    await this.saveLinks("person", links);
  }

  // ── pull: every linked person, least recently checked first ──

  async pullPeople() {
    const links = [...this.personLinks.values()].sort((a, b) => (parseTs(a.last_pulled_at) ?? 0) - (parseTs(b.last_pulled_at) ?? 0));
    for (const group of chunk(links, PEOPLE_CHUNK)) {
      if (this.timeUp(0.5)) break; // leave half the budget for the push; the rest waits for the next pull
      const contacts = await this.loadContacts(group.map((l) => l.local_id));
      const items = group.flatMap((link) => {
        const contact = contacts.get(link.local_id);
        return contact ? [{ contact, link }] : [];
      });
      try {
        await this.reconcile(items);
      } catch (e) {
        this.problem("pull people", e);
      }
    }
  }

  // ── push: companies ──

  private async loadAccounts(): Promise<AccountRow[]> {
    if (this.accountIdSet) {
      const out: AccountRow[] = [];
      for (const group of chunk([...this.accountIdSet], 100)) {
        const { data, error } = await this.db.from("accounts").select(ACCOUNT_COLS).eq("workspace_id", this.ws).in("id", group);
        if (error) throw new Error(`accounts: ${error.message}`);
        out.push(...((data ?? []) as unknown as AccountRow[]));
      }
      return out;
    }
    const all = await fetchAll<AccountRow>((from, to) =>
      this.db.from("accounts").select(ACCOUNT_COLS).eq("workspace_id", this.ws).eq("research_status", "qualified").order("id").range(from, to),
    );
    // Custom column edits count as account changes.
    const since = this.cursor.last_push_at ?? null;
    const changedValues = await fetchAll<{ account_id: string; updated_at: string }>((from, to) => {
      let q = this.db.from("account_field_values").select("account_id, updated_at").eq("workspace_id", this.ws);
      if (since) q = q.gt("updated_at", since);
      return q.order("account_id").order("column_id").range(from, to);
    });
    const valueTs = new Map<string, number>();
    for (const v of changedValues) valueTs.set(v.account_id, maxTs(valueTs.get(v.account_id), parseTs(v.updated_at))!);
    return all.filter((a) => {
      const link = this.companyLinks.get(a.id);
      if (!link) return true; // newly qualified (or never pushed)
      const changed = maxTs(parseTs(a.updated_at), valueTs.get(a.id));
      return changed != null && changed > (parseTs(link.last_pushed_at) ?? 0);
    });
  }

  private async fieldValues(accountIds: string[]): Promise<Map<string, Map<string, unknown>>> {
    const out = new Map<string, Map<string, unknown>>();
    if (!this.columnDefs.length) return out;
    for (const group of chunk(accountIds, 100)) {
      const { data, error } = await this.db.from("account_field_values").select("account_id, column_id, value").in("account_id", group);
      if (error) throw new Error(`field values: ${error.message}`);
      for (const v of (data ?? []) as { account_id: string; column_id: string; value: unknown }[]) {
        if (!out.has(v.account_id)) out.set(v.account_id, new Map());
        out.get(v.account_id)!.set(v.column_id, v.value);
      }
    }
    return out;
  }

  private companyFields(a: AccountRow, values: Map<string, unknown> | undefined): Record<string, FieldValue> {
    const fields: Record<string, FieldValue> = {};
    for (const [k, v] of Object.entries(companyFieldValues(a, this.appUrl))) if (this.available.has(k)) fields[k] = v;
    for (const def of this.columnDefs) {
      const v = toFieldValue(def, this.available.get(def.key)!, values?.get(def.columnId!));
      if (v != null) fields[def.key] = v;
    }
    return fields;
  }

  async pushCompanies() {
    const accounts = await this.loadAccounts();
    // Never-pushed first, then oldest change first.
    accounts.sort((a, b) => Number(this.companyLinks.has(a.id)) - Number(this.companyLinks.has(b.id)) || a.updated_at.localeCompare(b.updated_at));
    for (const group of chunk(accounts, ACCOUNT_CHUNK)) {
      if (this.timeUp()) break;
      try {
        await this.pushCompanyGroup(group);
      } catch (e) {
        this.problem("push companies", e);
      }
    }
  }

  private async pushCompanyGroup(group: AccountRow[]) {
    const values = await this.fieldValues(group.map((a) => a.id));
    const domainOf = (a: AccountRow) => normalizeDomain(a.companies?.domain) ?? normalizeDomain(a.companies?.website);
    const unlinked = group.filter((a) => !this.companyLinks.has(a.id));
    const found = unlinked.length
      ? await this.adapter.findCompanies({
          tidemarkIds: unlinked.map((a) => a.id),
          domains: [...new Set(unlinked.map(domainOf).filter((d): d is string => Boolean(d)))],
        })
      : { byTidemarkId: new Map(), byDomain: new Map() };

    const writes: CompanyWrite[] = [];
    const matched = new Set<string>();
    for (const a of group) {
      const link = this.companyLinks.get(a.id);
      const domain = domainOf(a);
      let remoteId = link?.remote_id ?? null;
      if (!remoteId) {
        const match = found.byTidemarkId.get(a.id) ?? (domain ? found.byDomain.get(domain) : undefined);
        const owner = match ? this.companyOwner.get(match.id) : undefined;
        if (match && owner && owner !== a.id) {
          this.warn(`account ${a.id}`, `${this.adapter.label} company ${match.id} is already linked to account ${owner}`);
          continue;
        }
        if (match) {
          remoteId = match.id;
          matched.add(a.id);
        }
      }
      writes.push({
        accountId: a.id,
        remoteId,
        name: a.companies?.name ?? domain ?? "Unnamed company",
        domain,
        fields: this.companyFields(a, values.get(a.id)),
      });
    }

    const results = await this.adapter.writeCompanies(writes);
    const links: LinkRow[] = [];
    const fresh: { accountId: string; remoteId: string; created: boolean | undefined }[] = [];
    for (const res of results) {
      if (res.error || !res.remoteId) {
        this.problem(`push company ${res.key}`, res.error ?? "no id returned");
        continue;
      }
      if (res.warning) this.warn(`company ${res.key}`, res.warning);
      const prev = this.companyLinks.get(res.key);
      if (prev) this.stats.companiesUpdated++;
      else {
        if (matched.has(res.key)) this.stats.companiesLinked++;
        else this.stats.companiesCreated++;
        this.newlyLinkedAccounts.add(res.key);
        fresh.push({ accountId: res.key, remoteId: res.remoteId, created: matched.has(res.key) ? false : res.created });
      }
      links.push({
        local_id: res.key,
        remote_id: res.remoteId,
        remote_updated_at: prev?.remote_updated_at ?? null,
        last_pushed_at: this.runAt,
        last_pulled_at: prev?.last_pulled_at ?? null,
      });
    }
    await this.saveLinks("company", links);

    if (fresh.length) {
      const label = this.adapter.label;
      const { error } = await this.db.from("activities").insert(
        fresh
          .filter((f) => this.companyLinks.has(f.accountId))
          .map((f) => ({
            workspace_id: this.ws,
            account_id: f.accountId,
            kind: "crm_push",
            title: f.created === true ? `Added to ${label}` : f.created === false ? `Matched to existing ${label} company` : `Synced to ${label}`,
            data: { provider: this.adapter.provider, connection_id: this.conn.id, remote_id: f.remoteId, created: f.created ?? null },
          })),
      );
      if (error) this.problem("activities", error.message);
    }
  }

  // ── push: people ──

  async pushPeople() {
    if (this.timeUp()) return;
    const light = await fetchAll<{ id: string; account_id: string; email: string | null; updated_at: string }>((from, to) =>
      this.db
        .from("contacts")
        .select("id, account_id, email, updated_at")
        .eq("workspace_id", this.ws)
        .not("account_id", "is", null)
        .order("id")
        .range(from, to),
    );
    const candidates = light.filter((c) => {
      if (this.handledContacts.has(c.id)) return false;
      if (this.accountIdSet && !this.accountIdSet.has(c.account_id)) return false;
      const link = this.personLinks.get(c.id);
      if (link) return Date.parse(c.updated_at) > (parseTs(link.last_pushed_at) ?? 0);
      // Unlinked: needs an email (the only safe dedupe key) and a pushed company.
      return Boolean(c.email) && this.companyLinks.has(c.account_id);
    });
    for (const group of chunk(candidates, PEOPLE_CHUNK)) {
      if (this.timeUp()) break;
      try {
        const rows = await this.loadContacts(group.map((c) => c.id));
        const linked: { contact: ContactRow; link: LinkRow }[] = [];
        const unlinked: ContactRow[] = [];
        for (const c of rows.values()) {
          const link = this.personLinks.get(c.id);
          if (link) linked.push({ contact: c, link });
          else if (c.email) unlinked.push(c);
        }
        await this.reconcile(linked);
        await this.linkOrCreate(unlinked);
      } catch (e) {
        this.problem("push people", e);
      }
    }
  }

  // ── push: lists (add-only) ──

  async pushLists() {
    if (this.timeUp()) return;
    const { data: lists, error } = await this.db.from("lists").select("id, name").eq("workspace_id", this.ws).order("created_at");
    if (error) throw new Error(`lists: ${error.message}`);
    if (!lists?.length) return;
    const listLinks = await this.loadLinks("list");
    const members = await fetchAll<{ list_id: string; account_id: string; added_at: string }>((from, to) =>
      this.db
        .from("list_members")
        .select("list_id, account_id, added_at")
        .eq("workspace_id", this.ws)
        .order("list_id")
        .order("account_id")
        .range(from, to),
    );

    for (const list of lists as { id: string; name: string }[]) {
      if (this.timeUp()) break;
      try {
        let link = listLinks.get(list.id);
        if (!link) {
          const remoteId = await this.adapter.ensureList(list);
          link = { local_id: list.id, remote_id: remoteId, remote_updated_at: null, last_pushed_at: null, last_pulled_at: null };
          await this.saveLinks("list", [link]);
          this.stats.listsLinked++;
        }
        // Members added (or whose company got linked) since this list was last fully pushed.
        const since = link.last_pushed_at ? Date.parse(link.last_pushed_at) - CLOCK_MARGIN_MS : null;
        const remoteIds = new Set<string>();
        for (const m of members) {
          if (m.list_id !== list.id) continue;
          if (this.accountIdSet && !this.accountIdSet.has(m.account_id)) continue;
          const company = this.companyLinks.get(m.account_id);
          if (!company) continue;
          const fresh =
            since == null ||
            Date.parse(m.added_at) > since ||
            this.newlyLinkedAccounts.has(m.account_id) ||
            (parseTs(company.created_at) ?? 0) > since;
          if (fresh) remoteIds.add(company.remote_id);
        }
        let complete = true;
        for (const group of chunk([...remoteIds], LIST_CHUNK)) {
          if (this.timeUp()) {
            complete = false;
            break;
          }
          this.stats.listMembersAdded += await this.adapter.addToList(link.remote_id, group);
        }
        if (complete && !this.accountIdSet) await this.saveLinks("list", [{ ...link, last_pushed_at: this.runAt }]);
      } catch (e) {
        this.problem(`list "${list.name}"`, e);
      }
    }
  }

  /** Did this run write anything? (guards against continuation loops) */
  get madeProgress(): boolean {
    const s = this.stats;
    return (
      s.companiesCreated + s.companiesLinked + s.companiesUpdated + s.peopleCreated + s.peopleLinked + s.peopleUpdated + s.peoplePulled + s.listsLinked + s.listMembersAdded >
      0
    );
  }

  summary(mode: Mode) {
    return {
      mode,
      at: this.runAt,
      ms: Date.now() - this.started,
      truncated: this.truncated,
      ...this.stats,
      messages: this.messages,
    };
  }
}

function tsIso(t: number | null | undefined): string | null {
  return t != null && Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function runSync(db: SupabaseClient, connectionId: string, mode: Mode, accountIds?: string[]) {
  const lease = await acquireLease(db, connectionId);
  if (lease.state === "gone") return { skipped: "connection removed" };
  if (!isCrmProvider(lease.conn.provider)) throw new Error(`Connection ${connectionId} is not a CRM connection`);
  if (lease.state === "locked") {
    // A pull is periodic, so skipping is fine; a push was asked for, so retry it.
    if (mode === "push") {
      await enqueue(
        "crm.push",
        { connectionId, ...(accountIds?.length ? { accountIds } : {}) },
        { workspaceId: lease.conn.workspace_id, runAfter: new Date(Date.now() + 60_000), priority: 70 },
      );
    }
    return { skipped: "another sync is running" };
  }

  const { conn, cursor } = lease;
  const base = withoutLock(cursor);
  const label = CRM_LABEL[conn.provider as CrmProvider];
  let run: SyncRun | null = null;
  try {
    const adapter = await adapterFor(db, conn);
    run = new SyncRun(db, conn, adapter, base, accountIds);
    await run.loadState();
    await run.schema();
    if (mode === "pull") await run.pullPeople();
    await run.pushCompanies();
    await run.pushPeople();
    await run.pushLists();

    const summary = run.summary(mode);
    const complete = !run.truncated && !accountIds?.length;
    const next: CrmCursor = {
      ...base,
      schema_key: run.schemaKey ?? base.schema_key,
      last_run: summary,
      ...(complete ? { last_push_at: run.runStartedAt } : {}),
    };
    await markSynced(db, conn.id, next);
    if (run.truncated && run.madeProgress) {
      // Time box hit: a follow-up job continues where dirty tracking left off.
      try {
        await enqueue("crm.push", { connectionId, ...(accountIds?.length ? { accountIds } : {}) }, { workspaceId: conn.workspace_id, priority: 70 });
      } catch (e) {
        console.error(`[crm] could not enqueue follow-up push for ${connectionId}: ${errMessage(e)}`);
      }
    }
    return summary;
  } catch (e) {
    if (isAuthError(e)) await markError(db, conn.id, `${label} rejected Tidemark's credentials — reconnect ${label}.`);
    await db
      .from("integration_connections")
      .update({ sync_cursor: { ...base, ...(run ? { last_run: { ...run.summary(mode), failed: errMessage(e).slice(0, 300) } } : {}) } })
      .eq("id", conn.id);
    throw e;
  }
}

export const crmHandlers: HandlerTable = {
  "crm.push": (db, p) => runSync(db, p.connectionId, "push", p.accountIds),
  "crm.pull": (db, p) => runSync(db, p.connectionId, "pull"),
};

// ── Import (chat, after the user confirms) ───────────────────────────────────

export interface ImportPersonResult {
  status: "imported" | "linked_existing" | "already_linked" | "not_found";
  provider: CrmProvider;
  contactId?: string;
  accountId?: string | null;
  name?: string | null;
}

/**
 * Bring one person who exists only in the CRM into Tidemark: creates (or
 * links) the local contact, attaches it to the matching prospect when the
 * CRM company is synced or shares a domain, and records the crm_links row so
 * future CRM edits flow back. `db` must be a service-role client
 * (createAdminClient()); authorize the caller first and pass `workspaceId`
 * to guard against cross-workspace ids.
 */
export async function importPersonFromCrm(
  db: SupabaseClient,
  connectionId: string,
  email: string,
  opts: { workspaceId?: string; userId?: string } = {},
): Promise<ImportPersonResult> {
  const conn = await getConnection(db, connectionId);
  if (!isCrmProvider(conn.provider)) throw new Error("That connection is not a CRM");
  const provider = conn.provider;
  if (opts.workspaceId && conn.workspace_id !== opts.workspaceId) throw new Error("Connection belongs to another workspace");
  const addr = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw new Error(`"${email}" is not an email address`);

  const adapter = await adapterFor(db, conn);
  let remote: RemotePerson | undefined;
  try {
    remote = (await adapter.findPeopleByEmail([addr])).get(addr);
  } catch (e) {
    if (isAuthError(e)) await markError(db, conn.id, `${CRM_LABEL[provider]} rejected Tidemark's credentials — reconnect ${CRM_LABEL[provider]}.`);
    throw e;
  }
  if (!remote) return { status: "not_found", provider };
  const person = remote;
  const name = person.values.fullName;

  const { data: linked } = await db
    .from("crm_links")
    .select("local_id")
    .eq("connection_id", conn.id)
    .eq("object_type", "person")
    .eq("remote_id", person.id)
    .maybeSingle();
  if (linked?.local_id) return { status: "already_linked", provider, contactId: linked.local_id as string, name };

  const { data: local } = await db
    .from("contacts")
    .select("id, account_id")
    .eq("workspace_id", conn.workspace_id)
    .eq("email", addr)
    .maybeSingle();

  const link = (row: { local_id: string; remote_updated_at: string | null; last_pushed_at: string | null; last_pulled_at: string | null }) =>
    db.from("crm_links").upsert(
      {
        workspace_id: conn.workspace_id,
        connection_id: conn.id,
        object_type: "person",
        remote_id: person.id,
        ...row,
      },
      { onConflict: "connection_id,object_type,local_id" },
    );

  if (local) {
    // Existing Tidemark contact: link it with no sync history, so the next
    // sync merges it like a first link (CRM wins conflicts, Tidemark fills blanks).
    const { error } = await link({ local_id: local.id as string, remote_updated_at: null, last_pushed_at: null, last_pulled_at: null });
    if (error) throw new Error(`link contact: ${error.message}`);
    return { status: "linked_existing", provider, contactId: local.id as string, accountId: (local.account_id as string | null) ?? null, name };
  }

  const target = await resolveAccount(db, conn, adapter, person, addr);
  const v = person.values;
  const { data: created, error } = await db
    .from("contacts")
    .insert({
      workspace_id: conn.workspace_id,
      account_id: target.accountId,
      company_id: target.companyId,
      full_name: v.fullName ?? addr.split("@")[0],
      first_name: v.firstName,
      last_name: v.lastName,
      title: v.title,
      email: addr,
      phone: v.phone,
      linkedin_url: v.linkedinUrl,
      source: provider,
      source_ref: person.id,
      created_by: opts.userId ?? null,
    })
    .select("id, updated_at")
    .single();
  if (error || !created) throw new Error(`create contact: ${error?.message ?? "no row"}`);

  const now = Date.now();
  const { error: linkError } = await link({
    local_id: created.id as string,
    remote_updated_at: tsIso(person.version),
    last_pushed_at: tsIso(maxTs(now, parseTs(created.updated_at as string))),
    last_pulled_at: new Date(now).toISOString(),
  });
  if (linkError) throw new Error(`link contact: ${linkError.message}`);
  return { status: "imported", provider, contactId: created.id as string, accountId: target.accountId, name };
}

/** Prospect a CRM person belongs to: via a synced CRM company, else by domain. */
async function resolveAccount(
  db: SupabaseClient,
  conn: ConnectionRow,
  adapter: CrmAdapter,
  remote: RemotePerson,
  email: string,
): Promise<{ accountId: string | null; companyId: string | null }> {
  let companyIds: string[] = [];
  try {
    companyIds = await adapter.personCompanyIds(remote);
  } catch {
    companyIds = [];
  }
  if (companyIds.length) {
    const { data } = await db
      .from("crm_links")
      .select("local_id")
      .eq("connection_id", conn.id)
      .eq("object_type", "company")
      .in("remote_id", companyIds.slice(0, 50))
      .limit(1);
    const accountId = (data?.[0]?.local_id as string | undefined) ?? null;
    if (accountId) {
      const { data: acc } = await db.from("accounts").select("id, company_id").eq("id", accountId).maybeSingle();
      if (acc) return { accountId: acc.id as string, companyId: acc.company_id as string };
    }
  }
  const domains = new Set<string>();
  if (companyIds.length) {
    try {
      for (const c of await adapter.getCompanies(companyIds.slice(0, 20))) if (c.domain) domains.add(c.domain);
    } catch {
      // fall through to the email domain
    }
  }
  const emailDomain = normalizeDomain(email.split("@")[1]);
  if (emailDomain) domains.add(emailDomain);
  if (!domains.size) return { accountId: null, companyId: null };
  const { data: companies } = await db.from("companies").select("id").in("domain", [...domains]).limit(20);
  const ids = (companies ?? []).map((c) => c.id as string);
  if (!ids.length) return { accountId: null, companyId: null };
  const { data: acc } = await db.from("accounts").select("id, company_id").eq("workspace_id", conn.workspace_id).in("company_id", ids).limit(1);
  if (acc?.[0]) return { accountId: acc[0].id as string, companyId: acc[0].company_id as string };
  return { accountId: null, companyId: ids[0] };
}
