import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeDomain } from "./normalize";

// Warm paths: who on the team can get an introduction. Built only from data
// the team owns — their Gmail correspondents, a LinkedIn connections export
// they uploaded, CRM records and meeting attendees. (No LinkedIn scraping.)
//
//   is_the_contact   a teammate already knows the decision maker
//   works_there      a teammate knows someone at the company (by email domain / company)
//   met_company      met someone from the company (Granola)
//   emailed_company  has corresponded with the company's domain

const SOURCE_STRENGTH: Record<string, number> = {
  gmail: 70, granola: 80, linkedin_export: 55, hubspot: 60, attio: 60, manual: 65,
};

interface Connection {
  id: string;
  member_id: string;
  full_name: string;
  email: string | null;
  title: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_id: string | null;
  linkedin_url: string | null;
  source: string;
  interactions: number;
}

export async function computeWarmPaths(db: SupabaseClient, accountId: string) {
  const { data: acc } = await db
    .from("accounts")
    .select("id, workspace_id, company_id, companies(name, domain)")
    .eq("id", accountId)
    .single();
  if (!acc) throw new Error("account not found");
  const company = acc.companies as unknown as { name: string; domain: string | null };
  const domain = normalizeDomain(company.domain);

  const filters = [`company_id.eq.${acc.company_id}`];
  if (domain) filters.push(`company_domain.eq.${domain}`);
  const { data: conns } = await db
    .from("network_connections")
    .select("id, member_id, full_name, email, title, company_name, company_domain, company_id, linkedin_url, source, interactions")
    .eq("workspace_id", acc.workspace_id)
    .or(filters.join(","));

  const { data: contacts } = await db.from("contacts").select("id, full_name, email, linkedin_url, role_tag").eq("account_id", acc.id);
  const { data: members } = await db.from("profiles").select("id, full_name, email");
  const memberName = new Map((members ?? []).map((m) => [m.id as string, (m.full_name as string) || (m.email as string) || "A teammate"]));

  const rows = [];
  for (const c of (conns ?? []) as Connection[]) {
    const contact = (contacts ?? []).find(
      (k) => (k.email && c.email && k.email.toLowerCase() === c.email.toLowerCase()) ||
        (k.linkedin_url && c.linkedin_url && k.linkedin_url.replace(/\/$/, "") === c.linkedin_url.replace(/\/$/, "")) ||
        k.full_name.toLowerCase() === c.full_name.toLowerCase(),
    );
    const via = memberName.get(c.member_id) ?? "A teammate";
    const how = c.source === "gmail" ? "from email" : c.source === "granola" ? "from a meeting" : c.source === "linkedin_export" ? "on LinkedIn" : `in ${c.source}`;
    const pathType = contact ? "is_the_contact" : c.source === "granola" ? "met_company" : "works_there";
    const strength = Math.min(100, (SOURCE_STRENGTH[c.source] ?? 50) + Math.min(20, c.interactions * 2) + (contact ? 10 : 0));
    rows.push({
      workspace_id: acc.workspace_id,
      account_id: acc.id,
      connection_id: c.id,
      contact_id: contact?.id ?? null,
      member_id: c.member_id,
      path_type: pathType,
      strength,
      explanation: contact
        ? `${via} knows ${c.full_name}${c.title ? ` (${c.title})` : ""} directly ${how}`
        : `Intro via ${c.full_name}${c.title ? ` (${c.title})` : ""} · ${via} knows them ${how}`,
    });
  }

  await db.from("warm_paths").delete().eq("account_id", acc.id);
  if (rows.length) {
    const { error } = await db.from("warm_paths").insert(rows);
    if (error) throw new Error(`warm paths: ${error.message}`);
  }
  return { paths: rows.length };
}

/** LinkedIn "Connections.csv" export → network rows (user uploads their own data). */
export function parseLinkedInConnections(rows: Record<string, string>[]) {
  return rows
    .map((r) => {
      const get = (...keys: string[]) => {
        for (const k of keys) {
          const hit = Object.keys(r).find((x) => x.trim().toLowerCase() === k.toLowerCase());
          if (hit && r[hit]?.trim()) return r[hit].trim();
        }
        return null;
      };
      const first = get("First Name"), last = get("Last Name");
      const full = [first, last].filter(Boolean).join(" ");
      if (!full) return null;
      const email = get("Email Address");
      return {
        full_name: full,
        email,
        title: get("Position"),
        company_name: get("Company"),
        company_domain: email ? normalizeDomain(email.split("@")[1]) : null,
        linkedin_url: get("URL"),
        connected_on: get("Connected On"),
      };
    })
    .filter(Boolean) as { full_name: string; email: string | null; title: string | null; company_name: string | null; company_domain: string | null; linkedin_url: string | null; connected_on: string | null }[];
}

export function identityKey(c: { email?: string | null; linkedin_url?: string | null; full_name: string }): string {
  return (c.email?.toLowerCase() || c.linkedin_url?.toLowerCase().replace(/\/$/, "") || c.full_name.toLowerCase()).slice(0, 300);
}
