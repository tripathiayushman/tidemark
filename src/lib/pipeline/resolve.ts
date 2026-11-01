import type { SupabaseClient } from "@supabase/supabase-js";
import { connectorFor } from "@/lib/sources";
import type { StoredRecord } from "@/lib/sources/types";
import { companyKey, normalizeDomain, stateCode, titleCaseCompany, zip5 } from "./normalize";

// Entity resolution + signal extraction for newly ingested records.
//
// Matching ladder (first hit wins):
//   1. registry identifier (UEI / USDOT)            → confidence 1.0
//   2. domain                                       → 0.98
//   3. exact normalized name (+ same state if known)→ 0.95
//   4. fuzzy name (trigram) with location agreement → similarity-based
//   5. otherwise create a new company                → "created"
// Every alternate spelling is stored as an alias so the next record with
// that spelling matches exactly.

const FUZZY_ACCEPT = 0.82;          // accept without location agreement
const FUZZY_ACCEPT_WITH_LOC = 0.6;  // accept when state + (city or zip) agree

interface Candidate {
  company_id: string;
  similarity: number;
  same_state: boolean;
  same_city: boolean;
  same_zip: boolean;
  matched_on: string;
}

export interface ResolveStats {
  processed: number;
  failed: number;
  matched: number;
  created: number;
  signals: number;
  skipped: number;
}

export interface ResolveOptions {
  limit?: number;        // max records to load this pass
  budgetMs?: number;     // stop starting new work after this long
  concurrency?: number;  // parallel company groups
}

/**
 * Resolves unprocessed records. Records are grouped by normalized company
 * name (or registry id) so two records for the same new company are never
 * resolved at the same time — that would create duplicates. Groups run in
 * parallel; records inside a group run in order. Returns `remaining` so
 * callers can schedule a follow-up pass.
 */
export async function resolvePendingRecords(db: SupabaseClient, limitOrOpts: number | ResolveOptions = 500): Promise<ResolveStats & { remaining: number }> {
  const opts: ResolveOptions = typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
  const limit = opts.limit ?? 500;
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  const stats: ResolveStats = { processed: 0, failed: 0, matched: 0, created: 0, signals: 0, skipped: 0 };
  const { data: rows, error } = await db
    .from("source_records")
    .select("*")
    .is("processed_at", null)
    .order("ingested_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`load records: ${error.message}`);

  const groups = new Map<string, StoredRecord[]>();
  for (const rec of (rows ?? []) as StoredRecord[]) {
    const ids = rec.entity_identifiers ?? {};
    const key = rec.company_id ?? ids.uei ?? ids.usdot ?? companyKey(rec.entity_name) ?? rec.id;
    const g = groups.get(key) ?? [];
    g.push(rec);
    groups.set(key, g);
  }
  const queue = [...groups.values()];
  let untouched = 0;
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, async () => {
    for (;;) {
      const group = queue.shift();
      if (!group) return;
      if (Date.now() > deadline) { untouched += group.length; continue; }
      for (const rec of group) await resolveOne(db, rec, stats);
    }
  });
  await Promise.all(workers);

  const { count } = await db.from("source_records").select("id", { count: "exact", head: true }).is("processed_at", null);
  return { ...stats, remaining: count ?? untouched };
}

async function resolveOne(db: SupabaseClient, rec: StoredRecord, stats: ResolveStats) {
  stats.processed++;
  try {
    let companyId = rec.company_id;
    if (!companyId) {
      if (!rec.entity_name || !companyKey(rec.entity_name)) {
        await markProcessed(db, rec.id, { match_method: "no_entity" });
        stats.skipped++;
        return;
      }
      const res = await resolveCompany(db, rec, { allowCreate: !connectorFor(rec.source, rec.dataset)?.matchOnly });
      if (!res) {
        await markProcessed(db, rec.id, { match_method: "no_match" });
        stats.skipped++;
        return;
      }
      companyId = res.companyId;
      if (res.created) stats.created++;
      else stats.matched++;
      await db
        .from("source_records")
        .update({ company_id: companyId, match_confidence: res.confidence, match_method: res.method, matched_at: new Date().toISOString() })
        .eq("id", rec.id);
    }

    const connector = connectorFor(rec.source, rec.dataset);
    const drafts = connector ? connector.toSignals({ ...rec, company_id: companyId }) : [];
    if (connector?.afterMatch) {
      const extra = await connector.afterMatch(db, { ...rec, company_id: companyId }, companyId);
      if (extra?.length) drafts.push(...extra);
    }
    if (drafts.length) {
      const { error: sErr } = await db.from("signals").upsert(
        drafts.map((d) => ({
          company_id: companyId,
          source_record_id: rec.id,
          source: rec.source,
          is_synthetic: rec.is_synthetic ?? false,
          category: d.category,
          signal_type: d.signal_type,
          title: d.title,
          detail: d.detail ?? null,
          occurred_on: d.occurred_on,
          amount: d.amount ?? null,
          quantity: d.quantity ?? null,
          unit: d.unit ?? null,
          location: d.location ?? null,
          source_url: d.source_url ?? rec.url ?? null,
          attributes: d.attributes ?? {},
          strength: Math.max(0, Math.min(100, Math.round(d.strength))),
        })),
        { onConflict: "source_record_id,signal_type", ignoreDuplicates: true },
      );
      if (sErr) throw new Error(`insert signals: ${sErr.message}`);
      stats.signals += drafts.length;
    }
    await markProcessed(db, rec.id, {});
  } catch (e) {
    // leave unprocessed so the next pass retries
    stats.failed++;
    console.error(`[resolve] record ${rec.id}: ${(e as Error).message}`);
  }
}

async function markProcessed(db: SupabaseClient, id: string, extra: Record<string, unknown>) {
  await db.from("source_records").update({ processed_at: new Date().toISOString(), ...extra }).eq("id", id);
}

export async function resolveCompany(
  db: SupabaseClient,
  rec: Pick<StoredRecord, "entity_name" | "entity_street" | "entity_city" | "entity_state" | "entity_postal_code" | "entity_identifiers" | "source" | "is_synthetic">,
  opts: { allowCreate?: boolean } = {},
): Promise<{ companyId: string; created: boolean; confidence: number; method: string } | null> {
  const ids = rec.entity_identifiers ?? {};
  const state = stateCode(rec.entity_state); // unknown / foreign values → null, never a guessed code

  // 1. identifiers
  for (const [col, val] of [["uei", ids.uei], ["usdot_number", ids.usdot]] as const) {
    if (!val) continue;
    const { data } = await db.from("companies").select("id").eq(col, val).maybeSingle();
    if (data) {
      await addAlias(db, data.id, rec.entity_name!, rec.source);
      return { companyId: data.id, created: false, confidence: 1, method: "identifier" };
    }
  }

  // 2. domain
  const domain = normalizeDomain(ids.domain);
  if (domain) {
    const { data } = await db.from("companies").select("id").eq("domain", domain).maybeSingle();
    if (data) {
      await addAlias(db, data.id, rec.entity_name!, rec.source);
      return { companyId: data.id, created: false, confidence: 0.98, method: "domain" };
    }
  }

  // 3–4. name candidates from SQL (trigram over names + aliases)
  const { data: cands, error } = await db.rpc("match_company_candidates", {
    p_name: rec.entity_name,
    p_state: state,
    p_city: rec.entity_city,
    p_postal_code: zip5(rec.entity_postal_code),
    p_limit: 5,
  });
  if (error) throw new Error(`match_company_candidates: ${error.message}`);
  const best = ((cands ?? []) as Candidate[])[0];
  if (best) {
    const locAgrees = best.same_state && (best.same_city || best.same_zip);
    const stateConflict = state != null && !best.same_state;
    const exact = best.similarity >= 0.999;
    if ((exact && !stateConflict) || (best.similarity >= FUZZY_ACCEPT && !stateConflict) || (best.similarity >= FUZZY_ACCEPT_WITH_LOC && locAgrees)) {
      await addAlias(db, best.company_id, rec.entity_name!, rec.source);
      await backfillIdentifiers(db, best.company_id, ids, domain);
      return {
        companyId: best.company_id,
        created: false,
        confidence: exact ? 0.95 : Number(best.similarity.toFixed(3)),
        method: exact ? "exact_name" : "fuzzy_name",
      };
    }
  }

  // 5. create (unless this source only enriches known companies)
  if (opts.allowCreate === false) return null;
  const { data: created, error: cErr } = await db
    .from("companies")
    .insert({
      name: titleCaseCompany(rec.entity_name!),
      legal_name: rec.entity_name,
      street: rec.entity_street ?? null,
      city: rec.entity_city ? titleCaseCompany(rec.entity_city) : null,
      state,
      postal_code: zip5(rec.entity_postal_code),
      uei: ids.uei ?? null,
      usdot_number: ids.usdot ?? null,
      duns: ids.duns ?? null,
      domain,
      website: domain ? `https://${domain}` : null,
      is_synthetic: rec.is_synthetic ?? false,
    })
    .select("id")
    .single();
  if (cErr) {
    // A concurrent run may have created the same identifier; retry the lookup once.
    if (cErr.code === "23505") return resolveCompany(db, rec, opts);
    throw new Error(`create company: ${cErr.message}`);
  }
  await addAlias(db, created.id, rec.entity_name!, rec.source, "legal");
  return { companyId: created.id, created: true, confidence: 1, method: "created" };
}

async function addAlias(db: SupabaseClient, companyId: string, alias: string, source: string, kind = "seen_as") {
  await db
    .from("company_aliases")
    .upsert({ company_id: companyId, alias, kind, source }, { onConflict: "company_id,alias_key", ignoreDuplicates: true });
}

async function backfillIdentifiers(db: SupabaseClient, companyId: string, ids: Record<string, string>, domain: string | null) {
  const patch: Record<string, string> = {};
  if (ids.uei) patch.uei = ids.uei;
  if (ids.usdot) patch.usdot_number = ids.usdot;
  if (domain) patch.domain = domain;
  if (!Object.keys(patch).length) return;
  const { data } = await db.from("companies").select("uei, usdot_number, domain").eq("id", companyId).single();
  const fill: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) if (!(data as Record<string, unknown> | null)?.[k]) fill[k] = v;
  if (Object.keys(fill).length) {
    // ignore unique conflicts (identifier already on another company)
    await db.from("companies").update(fill).eq("id", companyId);
  }
}
