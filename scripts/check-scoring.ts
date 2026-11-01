// Sanity check for the deterministic scorer against the demo stories:
// expansion / new_line / contract / relocation should rank well; lone /
// stale / off_icp should not. No database or API calls.
//   npx tsx scripts/check-scoring.ts
import { generateSeed } from "@/lib/seed/generate";
import { scoreAccount } from "@/lib/pipeline/scoring";
import type { Company, Icp, Signal } from "@/lib/types";

const icp: Icp = {
  id: "icp", workspace_id: "ws", name: "Mid-market", description: null, is_primary: true, is_active: true,
  criteria: {
    industries: [
      { naics_prefix: "3362", label: "Truck bodies & trailers" }, { naics_prefix: "3327", label: "Machine shops" },
      { naics_prefix: "3323", label: "Structural metal" }, { naics_prefix: "3261", label: "Plastics" },
      { naics_prefix: "3119", label: "Food" }, { naics_prefix: "3332", label: "Industrial machinery" },
      { naics_prefix: "3363", label: "Auto parts" }, { naics_prefix: "3371", label: "Cabinets" },
      { naics_prefix: "3255", label: "Coatings" }, { naics_prefix: "3344", label: "Electronics" },
    ],
    employee_min: 50, employee_max: 1500,
  },
  buyer_roles: [], signal_preferences: { min_corroborating: 2 },
};

const seed = generateSeed(120);
const byStory = new Map<string, { score: number; tier: string; fit: number; activity: number }[]>();
for (const c of seed) {
  const company: Company = {
    id: c.domain, name: c.name, domain: c.domain, website: null, description: c.description, naics_code: c.naics_code,
    naics_title: c.naics_title, industry: c.industry, employee_count: c.employee_count, annual_revenue: c.annual_revenue,
    street: c.street, city: c.city, state: c.state, postal_code: c.postal_code, linkedin_url: null, phone: null, is_synthetic: true,
  };
  const signals: Signal[] = c.records.map((r, i) => ({
    id: `${c.domain}:${i}`, company_id: c.domain, source_record_id: null, category: r.signal.category, signal_type: r.signal.signal_type,
    title: r.signal.title, detail: r.signal.detail ?? null, occurred_on: r.occurred_on, amount: r.signal.amount ?? null,
    quantity: r.signal.quantity ?? null, unit: r.signal.unit ?? null, location: r.signal.location ?? null, source: "seed",
    source_url: null, attributes: {}, strength: r.signal.strength, is_synthetic: true,
  }));
  const s = scoreAccount(company, icp, signals);
  const list = byStory.get(c.story) ?? [];
  list.push({ score: s.score, tier: s.tier, fit: s.fit, activity: s.activity });
  byStory.set(c.story, list);
}

let ok = true;
for (const [story, rows] of byStory) {
  const avg = (k: "score" | "fit" | "activity") => Math.round(rows.reduce((a, r) => a + r[k], 0) / rows.length);
  const tiers = rows.reduce<Record<string, number>>((m, r) => ((m[r.tier] = (m[r.tier] ?? 0) + 1), m), {});
  const good = ["expansion", "new_line", "contract", "relocation"].includes(story);
  const qualifyingShare = rows.filter((r) => r.tier !== "C").length / rows.length;
  const pass = good ? qualifyingShare >= 0.8 : qualifyingShare === 0;
  ok &&= pass;
  console.log(`${pass ? "✓" : "✗"} ${story.padEnd(11)} n=${rows.length.toString().padStart(2)}  score ${avg("score")}  fit ${avg("fit")}  activity ${avg("activity")}  tiers ${JSON.stringify(tiers)}`);
}
process.exit(ok ? 0 : 1);
