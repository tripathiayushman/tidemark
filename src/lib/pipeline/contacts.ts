import type { SupabaseClient } from "@supabase/supabase-js";
import { optionalEnv, serverEnv } from "@/lib/env";
import type { BuyerRole, RoleTag, Verification } from "@/lib/types";

// Finds decision makers for a qualified account and verifies their email.
//
// Licensing matters here: most contact vendors (Apollo, ZoomInfo,
// RocketReach) license data for internal use only, which rules them out as
// the source behind a customer-facing product. People Data Labs offers a
// product-use licence on its Enterprise tier, so it is the default provider.
// Apollo stays available only behind CONTACTS_ALLOW_APOLLO=true for teams
// with a written agreement. Synthetic demo companies use the seed provider.

export interface FoundContact {
  full_name: string;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  seniority?: string | null;
  department?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  location?: string | null;
  source: string;
  source_ref?: string | null;
}

interface ContactProvider {
  id: string;
  enabled(): boolean;
  find(company: { name: string; domain: string | null; state: string | null }, titles: string[]): Promise<FoundContact[]>;
}

// ── People Data Labs (Person Search API) ───────────────────────────────────
const pdl: ContactProvider = {
  id: "pdl",
  enabled: () => Boolean(serverEnv.pdlApiKey()),
  async find(company, titles) {
    if (!company.domain && !company.name) return [];
    const titleClauses = titles.slice(0, 6).map((t) => `job_title LIKE '%${t.replace(/'/g, "").toLowerCase()}%'`);
    const companyClause = company.domain ? `job_company_website='${company.domain}'` : `job_company_name='${company.name.replace(/'/g, "").toLowerCase()}'`;
    const sql = `SELECT * FROM person WHERE ${companyClause}${titleClauses.length ? ` AND (${titleClauses.join(" OR ")})` : ""}`;
    const res = await fetch("https://api.peopledatalabs.com/v5/person/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": serverEnv.pdlApiKey()! },
      body: JSON.stringify({ sql, size: 10 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`PDL ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    return (body.data ?? []).map((p) => ({
      full_name: String(p.full_name ?? "").replace(/\b\w/g, (m) => m.toUpperCase()),
      first_name: (p.first_name as string) ?? null,
      last_name: (p.last_name as string) ?? null,
      title: (p.job_title as string) ?? null,
      seniority: Array.isArray(p.job_title_levels) ? (p.job_title_levels[0] as string) : null,
      department: (p.job_title_role as string) ?? null,
      email: (p.work_email as string) ?? null,
      phone: Array.isArray(p.phone_numbers) ? (p.phone_numbers[0] as string) : null,
      linkedin_url: p.linkedin_url ? `https://${String(p.linkedin_url).replace(/^https?:\/\//, "")}` : null,
      location: (p.location_name as string) ?? null,
      source: "pdl",
      source_ref: (p.id as string) ?? null,
    })).filter((c) => c.full_name);
  },
};

// ── Hunter (domain search; emails only) ────────────────────────────────────
const hunter: ContactProvider = {
  id: "hunter",
  enabled: () => Boolean(serverEnv.hunterApiKey()),
  async find(company) {
    if (!company.domain) return [];
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(company.domain)}&type=personal&limit=20&api_key=${serverEnv.hunterApiKey()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Hunter ${res.status}`);
    const body = (await res.json()) as { data?: { emails?: Record<string, unknown>[] } };
    return (body.data?.emails ?? []).map((e) => ({
      full_name: [e.first_name, e.last_name].filter(Boolean).join(" ") || String(e.value),
      first_name: (e.first_name as string) ?? null,
      last_name: (e.last_name as string) ?? null,
      title: (e.position as string) ?? null,
      seniority: (e.seniority as string) ?? null,
      department: (e.department as string) ?? null,
      email: (e.value as string) ?? null,
      phone: (e.phone_number as string) ?? null,
      linkedin_url: (e.linkedin as string) ?? null,
      source: "hunter",
    }));
  },
};

// ── Apollo (only with a written agreement) ─────────────────────────────────
const apollo: ContactProvider = {
  id: "apollo",
  enabled: () => Boolean(serverEnv.apolloApiKey()) && optionalEnv("CONTACTS_ALLOW_APOLLO") === "true",
  async find(company, titles) {
    const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": serverEnv.apolloApiKey()! },
      body: JSON.stringify({ q_organization_domains_list: company.domain ? [company.domain] : undefined, person_titles: titles, per_page: 10 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Apollo ${res.status}`);
    const body = (await res.json()) as { people?: Record<string, unknown>[] };
    return (body.people ?? []).map((p) => ({
      full_name: String(p.name ?? ""),
      first_name: (p.first_name as string) ?? null,
      last_name: (p.last_name as string) ?? null,
      title: (p.title as string) ?? null,
      seniority: (p.seniority as string) ?? null,
      email: (p.email as string) ?? null,
      linkedin_url: (p.linkedin_url as string) ?? null,
      source: "apollo",
      source_ref: (p.id as string) ?? null,
    }));
  },
};

const PROVIDERS = [pdl, hunter, apollo];

export function contactProviderStatus() {
  return PROVIDERS.map((p) => ({ id: p.id, enabled: p.enabled() }));
}

// ── Email verification (ZeroBounce, else Hunter verifier) ──────────────────
export async function verifyEmail(email: string): Promise<Verification> {
  if (email.endsWith(".example")) return "valid"; // demo addresses are reserved, never sent
  const zb = serverEnv.zeroBounceApiKey();
  if (zb) {
    const res = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${zb}&email=${encodeURIComponent(email)}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return "unverified";
    const { status } = (await res.json()) as { status?: string };
    return status === "valid" ? "valid" : status === "invalid" || status === "spamtrap" || status === "abuse" ? "invalid" : status ? "risky" : "unverified";
  }
  const hk = serverEnv.hunterApiKey();
  if (hk) {
    const res = await fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${hk}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return "unverified";
    const { data } = (await res.json()) as { data?: { status?: string } };
    return data?.status === "valid" ? "valid" : data?.status === "invalid" ? "invalid" : data?.status ? "risky" : "unverified";
  }
  return "unverified";
}

// ── Role tagging against the ICP's buyer roles ─────────────────────────────
export function tagRole(title: string | null, roles: BuyerRole[]): RoleTag {
  if (!title) return "other";
  const t = title.toLowerCase();
  for (const r of roles) {
    const keys = [r.title, ...(r.title_keywords ?? [])].map((k) => k.toLowerCase());
    if (keys.some((k) => k && (t.includes(k) || k.includes(t)))) return r.role_tag;
  }
  if (/\b(owner|president|ceo|coo|chief|vp|vice president|general manager)\b/.test(t)) return "decision_maker";
  if (/\b(plant manager|operations manager|manufacturing engineer|engineering manager|director of operations|maintenance)\b/.test(t)) return "runs_the_build";
  if (/\b(purchasing|procurement|buyer|sourcing)\b/.test(t)) return "champion";
  return "other";
}

export async function findContactsForAccount(db: SupabaseClient, accountId: string) {
  const { data: acc } = await db
    .from("accounts")
    .select("id, workspace_id, company_id, icp_id, target_roles, companies(name, domain, state, is_synthetic)")
    .eq("id", accountId)
    .single();
  if (!acc) throw new Error("account not found");
  const company = acc.companies as unknown as { name: string; domain: string | null; state: string | null; is_synthetic: boolean };
  const { data: icp } = acc.icp_id ? await db.from("icps").select("buyer_roles").eq("id", acc.icp_id).single() : { data: null };
  const roles = ((icp?.buyer_roles as BuyerRole[]) ?? []);
  const titles = [...new Set([...(acc.target_roles as string[]), ...roles.map((r) => r.title)])].slice(0, 8);

  let found: FoundContact[] = [];
  let provider = "none";
  if (company.is_synthetic) {
    // demo contacts were created by the seed script; just (re)link them
    provider = "seed";
  } else {
    for (const p of PROVIDERS) {
      if (!p.enabled()) continue;
      found = await p.find(company, titles);
      provider = p.id;
      if (found.length) break;
    }
  }

  let saved = 0;
  for (const c of found.slice(0, 8)) {
    const status = c.email ? await verifyEmail(c.email) : "unverified";
    if (status === "invalid") continue;
    const row = {
      workspace_id: acc.workspace_id,
      company_id: acc.company_id,
      account_id: acc.id,
      full_name: c.full_name,
      first_name: c.first_name ?? null,
      last_name: c.last_name ?? null,
      title: c.title ?? null,
      seniority: c.seniority ?? null,
      department: c.department ?? null,
      role_tag: tagRole(c.title ?? null, roles),
      email: c.email ?? null,
      email_status: status,
      email_verified_at: status === "unverified" ? null : new Date().toISOString(),
      phone: c.phone ?? null,
      linkedin_url: c.linkedin_url ?? null,
      location: c.location ?? null,
      source: c.source,
      source_ref: c.source_ref ?? null,
    };
    const { error } = c.email
      ? await db.from("contacts").upsert(row, { onConflict: "workspace_id,email", ignoreDuplicates: true })
      : await db.from("contacts").insert(row);
    if (!error) saved++;
  }
  // Link any existing workspace contacts at this company (CRM imports, seed).
  await db.from("contacts").update({ account_id: acc.id }).eq("workspace_id", acc.workspace_id).eq("company_id", acc.company_id).is("account_id", null);
  return { provider, found: found.length, saved };
}
