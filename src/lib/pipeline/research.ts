import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { generateStructured, type Effort } from "@/lib/ai/llm";
import { optionalEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import type { Account, Company, Icp, SellerProfile } from "@/lib/types";
import { daysBetween, formatMoney } from "./normalize";
import { scoreAccount, type ScoredSignal } from "./scoring";

// Research one account: score it, then (if it could plausibly qualify) have
// Claude read the company's dated records in order and decide whether they
// add up to a reason to buy. Claude may only cite records it was shown; the
// code re-checks every citation and the corroboration rule afterwards.

const ReasonSchema = z.object({
  has_reason_to_buy: z.boolean().describe("True only if the records together point to a concrete, current reason this company would buy what the seller sells"),
  reason_to_buy: z.string().max(90, "reason_to_buy must be a short headline under 90 characters (about 8-12 words), not sentences").describe("A short HEADLINE of 4-12 words, no period, e.g. 'Fitting out a new 48,000 sq ft production floor'. Empty string if none."),
  reason_category: z.enum(["expansion", "new_line", "relocation", "new_contract", "retooling", "fleet_growth", "supplier_change", "other", "none"]),
  why: z.string().describe("1-2 full sentences tying the records to what the seller offers, e.g. 'The building is finished and a press brake has arrived, so they need cells and controls integrated and commissioned in the next quarter.' Plain language, no hype."),
  reasoning: z.string().describe("'Reading the timeline': 3-6 sentences walking through the records in date order and what each adds. Refer to records by what they are (e.g. 'the June SBA loan'). Never write record ids."),
  evidence: z.array(z.object({
    signal_id: z.string().describe("Exactly one of the record ids provided"),
    note: z.string().describe("One sentence: why this record counts toward the reason"),
  })).describe("The records that support the reason, strongest first. Empty if no reason."),
  timing_label: z.string().max(40, "timing_label must be short, like 'Expansion, next 90 days'").describe("Human label: a category word plus a horizon, e.g. 'Expansion, next 90 days' or 'New line, next 60 days'. Not a field name."),
  contact_window_start: z.string().describe("YYYY-MM-DD: earliest sensible date to reach out (today or later)"),
  contact_window_end: z.string().describe("YYYY-MM-DD: when the buying decision is likely made and outreach becomes late"),
  readiness: z.enum(["ready_now", "warming", "later"]),
  confidence: z.enum(["low", "medium", "high"]),
  next_step: z.string().describe("One concrete action for the seller, e.g. 'Call the plant manager about installation scheduling'"),
  target_roles: z.array(z.string()).describe("Job titles to contact at this company for this specific reason, most important first"),
});
export type ReasonOutput = z.infer<typeof ReasonSchema>;

const SYSTEM_PROMPT = `You are the research analyst inside Tidemark, a prospecting tool for B2B sellers whose buyers are US manufacturers.

You receive: what the seller sells, the seller's ideal customer profile, one company, and that company's dated public records (loans, permits, customs shipments, contract awards, supplier changes, fleet and registration filings, press) in date order, each with an id.

Your job is to decide whether these records, read together as a timeline, add up to a current reason this company would buy what the seller sells, and to explain it so a salesperson can trust it.

Rules:
- A single record is rarely enough. Qualify only when two or more independent records point the same way (for example: a building loan, then a permit on the new building, then machines arriving through customs → a new production floor). One record may suffice only if it is explicit and strong on its own (e.g. a large new-construction permit for a production plant).
- Only use facts present in the records. Never invent amounts, dates, names, or events. If something is unknown, leave it out.
- Cite only record ids from the provided list. Every evidence note must say why that record counts.
- Connect the reason to what the seller actually offers. If the company is changing but not in a way that creates need for the seller's offering, say no.
- Old records (well over a year) weaken the case; recent sequences strengthen it.
- Contact window: think about where the company is in its project. Money and permits come before construction; machines arriving means installation and commissioning soon; a closed-out permit means the building is done and the floor is being fitted out. The window should start no earlier than today and end when a decision is likely already made.
- Write plainly. No hype, no exclamation marks, no "exciting opportunity" language.
- Record ids are for the evidence list only — never write an id in reason_to_buy, why, reasoning, or notes.
- reason_to_buy is a headline (4-12 words), timing_label is a short label like "Expansion, next 90 days".
- If there is no reason to buy, set has_reason_to_buy=false, reason_category="none", leave reason_to_buy empty, evidence empty, and explain briefly in reasoning what is missing.`;

function fingerprint(signals: { id: string }[]): string {
  return createHash("sha256").update(signals.map((s) => s.id).sort().join(",")).digest("hex").slice(0, 32);
}

function describeSignal(s: ScoredSignal, today: string): string {
  const age = daysBetween(s.occurred_on, today);
  const bits = [
    `id=${s.id}`,
    s.occurred_on,
    `(${age} days ago)`,
    `[${s.category}]`,
    s.title,
    s.detail ? `— ${s.detail}` : "",
    s.amount ? `· amount ${formatMoney(s.amount)}` : "",
    s.location ? `· ${s.location}` : "",
    `· source: ${s.source}`,
    s.match_confidence != null && s.match_confidence < 0.9 ? `· company match confidence ${s.match_confidence.toFixed(2)}` : "",
  ];
  return bits.filter(Boolean).join(" ");
}

function sellerBlock(p: SellerProfile | null): string {
  if (!p || !p.summary) return "The seller has not described their offering yet. Judge whether the company is changing in a way that creates new purchasing needs in general.";
  return [
    `Summary: ${p.summary}`,
    p.offerings?.length ? `Offerings: ${p.offerings.map((o) => `${o.name} — ${o.description}`).join("; ")}` : "",
    p.buyer_problems?.length ? `Problems it solves: ${p.buyer_problems.join("; ")}` : "",
    p.buying_triggers?.length ? `Events that create need: ${p.buying_triggers.join("; ")}` : "",
    p.proof_points?.length ? `Proof: ${p.proof_points.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

function icpBlock(icp: Icp): string {
  return JSON.stringify({ name: icp.name, description: icp.description, criteria: icp.criteria, buyer_roles: icp.buyer_roles.map((r) => `${r.title} (${r.role_tag})`) });
}

function companyBlock(c: Company): string {
  return [
    `${c.name}${c.is_synthetic ? " (demo data)" : ""}`,
    [c.city, c.state].filter(Boolean).join(", "),
    c.industry || c.naics_title ? `Industry: ${c.industry ?? c.naics_title}${c.naics_code ? ` (NAICS ${c.naics_code})` : ""}` : "",
    c.employee_count ? `Employees: ~${c.employee_count}` : "",
    c.description ? `About: ${c.description}` : "",
  ].filter(Boolean).join("\n");
}

const UUID_RE = /\b(?:id=)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CATEGORY_WORD: Record<string, string> = {
  expansion: "Expansion", new_line: "New line", relocation: "Relocation", new_contract: "New contract",
  retooling: "Retooling", fleet_growth: "Fleet growth", supplier_change: "Supplier change", other: "Change", none: "Change",
};

/** Removes record ids the model sometimes pastes into prose, and tidies spacing. */
function scrubIds(text: string): string {
  return text.replace(/\s*\((?:\s*,?\s*(?:id=)?[0-9a-f-]{36})+\s*\)/gi, "").replace(UUID_RE, "").replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim();
}

/** Keeps model labels only when they look like labels; otherwise derives them. */
function cleanTiming(label: string, category: string, end: string, today: string): string {
  const looksRight = /^[A-Z][A-Za-z ]+, (next|within) \d+ (days|weeks|months)$/.test(label.trim()) || /^[A-Z][A-Za-z ]+, (now|this quarter|next quarter)$/i.test(label.trim());
  if (looksRight) return label.trim();
  const days = Math.max(14, Math.round((Date.parse(end) - Date.parse(today)) / 86_400_000));
  const horizon = days <= 45 ? 30 : days <= 75 ? 60 : days <= 120 ? 90 : 180;
  return `${CATEGORY_WORD[category] ?? "Change"}, next ${horizon} days`;
}

function cleanWhy(why: string, reasoning: string): string {
  const w = scrubIds(why);
  if (w.length >= 40 && /\s/.test(w) && !/^[a-z_]+$/.test(w)) return w;
  const first = scrubIds(reasoning).split(/(?<=\.)\s/)[0] ?? "";
  return first || w;
}

function clampWindow(out: ReasonOutput, today: string): { start: string; end: string } {
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
  let start = valid(out.contact_window_start) ? out.contact_window_start : today;
  if (start < today) start = today;
  let end = valid(out.contact_window_end) ? out.contact_window_end : "";
  if (!end || end < start) end = new Date(Date.parse(start) + 45 * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

export interface ResearchOutcome {
  status: Account["research_status"];
  tier: Account["tier"];
  score: number;
  skipped?: boolean;
}

export async function researchAccount(db: SupabaseClient, accountId: string, opts: { force?: boolean; today?: Date } = {}): Promise<ResearchOutcome> {
  const todayDate = opts.today ?? new Date();
  const today = todayDate.toISOString().slice(0, 10);

  const { data: account, error } = await db.from("accounts").select("*").eq("id", accountId).single();
  if (error || !account) throw new Error(`account ${accountId} not found`);
  const acc = account as Account;

  const [{ data: company }, { data: icpRow }, { data: seller }] = await Promise.all([
    db.from("companies").select("*").eq("id", acc.company_id).single(),
    acc.icp_id
      ? db.from("icps").select("*").eq("id", acc.icp_id).single()
      : db.from("icps").select("*").eq("workspace_id", acc.workspace_id).eq("is_primary", true).maybeSingle(),
    db.from("seller_profiles").select("*").eq("workspace_id", acc.workspace_id).maybeSingle(),
  ]);
  if (!company) throw new Error("company missing");
  if (!icpRow) throw new Error("workspace has no ICP yet");
  const icp = icpRow as Icp;

  const { data: sigRows } = await db
    .from("signals")
    .select("*, source_records(match_confidence)")
    .eq("company_id", acc.company_id)
    .order("occurred_on", { ascending: false })
    .limit(60);
  const signals: ScoredSignal[] = ((sigRows ?? []) as (ScoredSignal & { source_records: { match_confidence: number | null } | null })[]).map(
    (s) => ({ ...s, match_confidence: s.source_records?.match_confidence ?? null }),
  );

  const fp = fingerprint(signals);
  if (!opts.force && acc.signals_fingerprint === fp && acc.last_researched_at && acc.research_status !== "error") {
    await db.from("accounts").update({ last_researched_at: new Date().toISOString() }).eq("id", accountId);
    return { status: acc.research_status, tier: acc.tier, score: acc.score ?? 0, skipped: true };
  }

  await db.from("accounts").update({ research_status: "researching", research_error: null }).eq("id", accountId);
  const s = scoreAccount(company as Company, icp, signals, todayDate);
  const base = {
    fit_score: s.fit,
    fit_breakdown: s.fitBreakdown,
    activity_score: s.activity,
    activity_breakdown: s.activityBreakdown,
    score: s.score,
    tier: s.tier,
    icp_id: icp.id,
    last_signal_on: signals[0]?.occurred_on ?? null,
    signals_fingerprint: fp,
    last_researched_at: new Date().toISOString(),
  };

  // Cheap exits: no LLM call when the deterministic scores already say no.
  if (s.fit < 35) {
    await finish(db, acc, { ...base, research_status: "disqualified", reasoning: "Outside the ICP: " + s.fitBreakdown.filter((l) => l.score < 50).map((l) => l.note).join("; "), reason_to_buy: null, confidence: null });
    return { status: "disqualified", tier: s.tier, score: s.score };
  }
  if (s.recentSignals.length === 0 || s.activity < 15) {
    await finish(db, acc, { ...base, research_status: "not_now", reasoning: "No recent records that point to a change in operations.", reason_to_buy: null, confidence: null });
    return { status: "not_now", tier: s.tier, score: s.score };
  }

  await db.from("accounts").update({ research_status: "checking" }).eq("id", accountId);
  const timeline = [...s.recentSignals].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
  const prompt = [
    `Today is ${today}.`,
    `\n## What the seller sells\n${sellerBlock(seller as SellerProfile | null)}`,
    `\n## Ideal customer profile\n${icpBlock(icp)}`,
    `\n## Company\n${companyBlock(company as Company)}`,
    `\n## Deterministic scores (for context)\nFit ${s.fit}/100 · Activity ${s.activity}/100 · ${s.independentRecords} independent records across ${s.categories.length} categories.`,
    `\n## Records, oldest first\n${timeline.map((x) => describeSignal(x, today)).join("\n")}`,
  ].join("\n");

  const effort = (optionalEnv("RESEARCH_EFFORT") as Effort | undefined) ?? "medium";
  const { data: out, model } = await generateStructured({ system: SYSTEM_PROMPT, prompt, schema: ReasonSchema, effort, cacheSystem: true, task: "research" });

  // Re-check citations and the corroboration rule in code.
  const known = new Map(timeline.map((x) => [x.id, x]));
  const evidence = out.evidence.filter((e) => known.has(e.signal_id));
  const strongest = Math.max(0, ...evidence.map((e) => known.get(e.signal_id)!.strength));
  const minCorroborating = icp.signal_preferences?.min_corroborating ?? 2;
  const corroborated = evidence.length >= minCorroborating || (evidence.length >= 1 && strongest >= 70);
  const qualifies = out.has_reason_to_buy && corroborated && s.tier !== "C" && evidence.length > 0;
  const window = clampWindow(out, today);

  await finish(
    db,
    acc,
    {
      ...base,
      research_status: qualifies ? "qualified" : "not_now",
      reason_to_buy: qualifies ? out.reason_to_buy : null,
      reason_category: qualifies ? out.reason_category : null,
      why: qualifies ? cleanWhy(out.why, out.reasoning) : null,
      reasoning: scrubIds(out.reasoning) + (out.has_reason_to_buy && !qualifies ? (s.tier === "C" ? " (Held back: score below tier B.)" : " (Held back: not enough independent records.)") : ""),
      timing_label: qualifies ? cleanTiming(out.timing_label, out.reason_category, window.end, today) : null,
      readiness: qualifies ? out.readiness : null,
      confidence: out.confidence,
      contact_window_start: qualifies ? window.start : null,
      contact_window_end: qualifies ? window.end : null,
      next_step: qualifies ? out.next_step : null,
      target_roles: qualifies ? out.target_roles.slice(0, 8) : [],
      research_model: model,
    },
    qualifies ? evidence.map((e, i) => ({ signal_id: e.signal_id, note: scrubIds(e.note), position: i })) : [],
    qualifies ? out.target_roles : [],
  );
  return { status: qualifies ? "qualified" : "not_now", tier: s.tier, score: s.score };
}

async function finish(
  db: SupabaseClient,
  acc: Account,
  patch: Record<string, unknown>,
  evidence: { signal_id: string; note: string; position: number }[] = [],
  targetRoles: string[] = [],
) {
  const becameQualified = patch.research_status === "qualified" && acc.research_status !== "qualified";
  if (becameQualified && !acc.qualified_at) patch.qualified_at = new Date().toISOString();
  const { error } = await db.from("accounts").update(patch).eq("id", acc.id);
  if (error) throw new Error(`update account: ${error.message}`);

  await db.from("account_evidence").delete().eq("account_id", acc.id);
  if (evidence.length) {
    const { error: evErr } = await db
      .from("account_evidence")
      .insert(evidence.map((e) => ({ ...e, account_id: acc.id, workspace_id: acc.workspace_id })));
    if (evErr) throw new Error(`insert evidence: ${evErr.message}`);
  }

  if (becameQualified) {
    await db.from("activities").insert({
      workspace_id: acc.workspace_id,
      account_id: acc.id,
      kind: "qualified",
      title: `Qualified: ${patch.reason_to_buy}`,
      body: patch.why as string,
      data: { tier: patch.tier, score: patch.score, target_roles: targetRoles },
    });
    const { error: taskErr } = await db.from("tasks").insert({
      workspace_id: acc.workspace_id,
      account_id: acc.id,
      title: `Reach out: ${patch.reason_to_buy}`,
      description: `${patch.next_step ?? ""}${patch.contact_window_end ? `\nWindow closes ${patch.contact_window_end}.` : ""}`,
      kind: "reach_out",
      source: "system",
      due_on: patch.contact_window_start ?? null,
      assignee_id: acc.owner_id,
    });
    if (taskErr && taskErr.code !== "23505") console.error(`[research] task insert: ${taskErr.message}`);
    await enqueue("account.contacts", { accountId: acc.id }, { workspaceId: acc.workspace_id, dedupeKey: `contacts:${acc.id}`, priority: 50 });
    await enqueue("account.warm_paths", { accountId: acc.id }, { workspaceId: acc.workspace_id, dedupeKey: `warm:${acc.id}`, priority: 60 });
  }
}

