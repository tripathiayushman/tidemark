import type { SupabaseClient } from "@supabase/supabase-js";
import { generateSeed } from "./generate";
import { resolvePendingRecords } from "@/lib/pipeline/resolve";
import { matchWorkspace } from "@/lib/pipeline/match";

// Loads the fictional demo dataset (shared graph) and, for a workspace,
// its demo contacts; then puts matching companies on the watchlist.
export async function loadDemoData(db: SupabaseClient, workspaceId: string | null) {
  const seed = generateSeed(120);
  let companies = 0, records = 0;
  for (const c of seed) {
    const { data: company, error } = await db
      .from("companies")
      .upsert(
        {
          name: c.name, domain: c.domain, website: `https://${c.domain}`, description: c.description,
          naics_code: c.naics_code, naics_title: c.naics_title, industry: c.industry,
          employee_count: c.employee_count, annual_revenue: c.annual_revenue,
          street: c.street, city: c.city, state: c.state, postal_code: c.postal_code, is_synthetic: true,
        },
        { onConflict: "domain" },
      )
      .select("id")
      .single();
    if (error) throw new Error(`company ${c.name}: ${error.message}`);
    companies++;
    const rows = c.records.map((r) => ({
      source: "seed", dataset: "demo", external_id: r.external_id, record_type: r.record_type,
      occurred_on: r.occurred_on, entity_name: c.name, entity_city: c.city, entity_state: c.state,
      entity_postal_code: c.postal_code, amount: r.amount, raw: { signal: r.signal, story: c.story },
      company_id: company.id, match_method: "seed", match_confidence: 1, matched_at: new Date().toISOString(),
      is_synthetic: true,
    }));
    const { error: rErr } = await db.from("source_records").upsert(rows, { onConflict: "source,dataset,external_id", ignoreDuplicates: true });
    if (rErr) throw new Error(`records ${c.name}: ${rErr.message}`);
    records += rows.length;
    if (workspaceId) {
      const { error: cErr } = await db.from("contacts").upsert(
        c.contacts.map((p) => ({
          workspace_id: workspaceId, company_id: company.id, full_name: p.full_name, first_name: p.first_name,
          last_name: p.last_name, title: p.title, seniority: p.seniority, department: p.department, role_tag: p.role_tag,
          email: p.email, email_status: "valid", phone: p.phone, source: "seed",
        })),
        { onConflict: "workspace_id,email", ignoreDuplicates: true },
      );
      if (cErr) throw new Error(`contacts ${c.name}: ${cErr.message}`);
    }
  }
  let signals = 0;
  for (;;) {
    const r = await resolvePendingRecords(db, 1000);
    signals += r.signals;
    // stop when nothing is left or a pass made no progress (failures stay queued for the worker)
    if (r.processed === 0 || r.processed === r.failed) break;
  }
  const matched = workspaceId ? await matchWorkspace(db, workspaceId) : null;
  return { companies, records, signals, matched };
}
