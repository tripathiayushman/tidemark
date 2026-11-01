import type { Company, Icp, RecordSource, ScoreLine, Signal, SignalCategory, Tier } from "@/lib/types";
import { daysBetween } from "./normalize";

// Deterministic scoring. Fit first (does this company look like our buyer?),
// then activity (do dated records show something changing right now?).
// Same inputs always give the same scores; Claude only writes the narrative.
//
// Activity adjustments:
//   * time decay        — 120-day half-life on each record
//   * source reliability— government records > licensed > press
//   * entity confidence — fuzzy-matched records count less than exact matches
//   * independence      — repeats of the same event (same type within 21 days) count once
//   * corroboration     — fewer than `min_corroborating` independent records caps activity
//   * negative signals  — closures / WARN layoffs subtract

export const TIER_THRESHOLDS: Record<Exclude<Tier, "C">, number> = { S: 80, A: 65, B: 50 };
const HALF_LIFE_DAYS = 120;
const DEFAULT_LOOKBACK = 540;

const SOURCE_RELIABILITY: Record<RecordSource, number> = {
  usaspending: 1, sba: 1, permits: 1, fmcsa: 0.95, osha: 0.9, customs: 0.95,
  licensed: 0.9, website: 0.7, press: 0.75, manual: 0.8, seed: 1,
  federal_register: 1, ucc: 0.85, warn: 0.9,
};

const NEGATIVE_TYPES = new Set(["warn_notice", "plant_closure", "bankruptcy"]);

export interface ScoredSignal extends Signal {
  match_confidence?: number | null;
}

export interface ScoreResult {
  fit: number;
  fitBreakdown: ScoreLine[];
  activity: number;
  activityBreakdown: ScoreLine[];
  score: number;
  tier: Tier;
  independentRecords: number;
  categories: SignalCategory[];
  corroborated: boolean;
  recentSignals: ScoredSignal[];
}

export function scoreFit(company: Company, icp: Pick<Icp, "criteria">): { fit: number; lines: ScoreLine[] } {
  const c = icp.criteria ?? {};
  const lines: ScoreLine[] = [];
  const text = [company.name, company.description, company.industry, company.naics_title].filter(Boolean).join(" ").toLowerCase();

  // Industry (35)
  const industries = c.industries ?? [];
  let industry = 70;
  let industryNote = "No industry filter on this ICP";
  if (industries.length) {
    const naics = company.naics_code ?? "";
    const hit = industries.find((i) => naics && naics.startsWith(i.naics_prefix));
    if (hit) { industry = 100; industryNote = `NAICS ${naics} is in ${hit.label}`; }
    else if (!naics) { industry = 45; industryNote = "Industry code unknown"; }
    else if (/^3[1-3]/.test(naics) && industries.some((i) => /^3[1-3]/.test(i.naics_prefix))) { industry = 40; industryNote = `Manufacturer, but NAICS ${naics} is outside the target sub-industries`; }
    else { industry = 0; industryNote = `NAICS ${naics} is outside the ICP`; }
  }
  lines.push({ criterion: "Industry", score: industry, weight: 35, note: industryNote });

  // Size (25)
  const emp = company.employee_count;
  const lo = c.employee_min ?? null, hi = c.employee_max ?? null;
  let size = 70, sizeNote = "No size filter";
  if (lo != null || hi != null) {
    if (emp == null) { size = 50; sizeNote = "Headcount unknown"; }
    else if ((lo == null || emp >= lo) && (hi == null || emp <= hi)) { size = 100; sizeNote = `${emp} employees, inside ${lo ?? 0}–${hi ?? "∞"}`; }
    else {
      const edge = emp < (lo ?? 0) ? lo! : hi!;
      const ratio = emp < edge ? emp / edge : edge / emp;
      size = ratio >= 0.66 ? 60 : ratio >= 0.4 ? 30 : 5;
      sizeNote = `${emp} employees, outside ${lo ?? 0}–${hi ?? "∞"}`;
    }
  }
  lines.push({ criterion: "Company size", score: size, weight: 25, note: sizeNote });

  // Geography (20)
  const st = company.state?.toUpperCase() ?? null;
  let geo = 100, geoNote = "No geography filter";
  if (st && (c.exclude_states ?? []).map((s) => s.toUpperCase()).includes(st)) { geo = 0; geoNote = `${st} is excluded`; }
  else if ((c.states ?? []).length) {
    if (!st) { geo = 50; geoNote = "Location unknown"; }
    else if (c.states!.map((s) => s.toUpperCase()).includes(st)) { geo = 100; geoNote = `${st} is a target state`; }
    else { geo = 15; geoNote = `${st} is outside target states`; }
  }
  lines.push({ criterion: "Geography", score: geo, weight: 20, note: geoNote });

  // Keywords (20)
  const kws = (c.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const excl = (c.exclude_keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const exclHit = excl.find((k) => text.includes(k));
  let kw = kws.length ? 30 : 70, kwNote = kws.length ? "No ICP keywords found" : "No keyword filter";
  const kwHit = kws.filter((k) => text.includes(k));
  if (kwHit.length) { kw = Math.min(100, 70 + kwHit.length * 15); kwNote = `Matches ${kwHit.slice(0, 3).join(", ")}`; }
  if (exclHit) { kw = 0; kwNote = `Excluded keyword "${exclHit}"`; }
  lines.push({ criterion: "Keywords", score: kw, weight: 20, note: kwNote });

  let fit = Math.round(lines.reduce((s, l) => s + l.score * l.weight, 0) / lines.reduce((s, l) => s + l.weight, 0));
  if (exclHit || industry === 0 || geo === 0) fit = Math.min(fit, 30); // hard disqualifiers cap fit
  return { fit, lines };
}

export function scoreActivity(signals: ScoredSignal[], icp: Pick<Icp, "signal_preferences">, today = new Date()): Omit<ScoreResult, "fit" | "fitBreakdown" | "score" | "tier"> {
  const prefs = icp.signal_preferences ?? {};
  const lookback = prefs.lookback_days ?? DEFAULT_LOOKBACK;
  const minCorroborating = prefs.min_corroborating ?? 2;
  const todayIso = today.toISOString().slice(0, 10);

  const recent = signals
    .filter((s) => {
      const age = daysBetween(s.occurred_on, todayIso);
      return age >= -30 && age <= lookback;
    })
    .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));

  // independence: collapse same-type events within 21 days, keep the strongest
  const independent: ScoredSignal[] = [];
  for (const s of [...recent].sort((a, b) => b.strength - a.strength)) {
    const dup = independent.find((k) => k.signal_type === s.signal_type && Math.abs(daysBetween(k.occurred_on, s.occurred_on)) <= 21);
    if (!dup) independent.push(s);
  }

  const lines: ScoreLine[] = [];
  let total = 0;
  let negative = 0;
  for (const s of independent) {
    const age = Math.max(0, daysBetween(s.occurred_on, todayIso));
    const decay = Math.pow(0.5, age / HALF_LIFE_DAYS);
    const weight = prefs.weights?.[s.category] ?? 1;
    const reliability = SOURCE_RELIABILITY[s.source] ?? 0.8;
    const entity = s.match_confidence == null ? 1 : Math.max(0.5, Math.min(1, s.match_confidence));
    const contribution = s.strength * decay * weight * reliability * entity;
    if (NEGATIVE_TYPES.has(s.signal_type)) {
      negative += contribution;
      lines.push({ criterion: s.title, score: -Math.round(contribution), weight: 1, note: `Negative signal, ${age} days ago` });
      continue;
    }
    total += contribution;
    lines.push({
      criterion: s.title,
      score: Math.round(contribution),
      weight: 1,
      note: `${age}d ago · strength ${s.strength} · decay ${decay.toFixed(2)}${weight !== 1 ? ` · weight ${weight}` : ""}${entity < 1 ? ` · match ${entity.toFixed(2)}` : ""}`,
    });
  }

  const positives = independent.filter((s) => !NEGATIVE_TYPES.has(s.signal_type));
  const categories = [...new Set(positives.map((s) => s.category))];
  const diversity = 0.75 + 0.125 * Math.min(categories.length - 1, 2); // 0.75 → 1.0 with 3+ categories
  let activity = 100 * (1 - Math.exp(-(Math.max(0, total - negative)) / 110)) * (categories.length ? diversity : 0);
  const corroborated = positives.length >= minCorroborating;
  if (!corroborated) activity = Math.min(activity, 45);

  return {
    activity: Math.round(Math.max(0, Math.min(100, activity))),
    activityBreakdown: lines,
    independentRecords: positives.length,
    categories,
    corroborated,
    recentSignals: recent,
  };
}

export function tierFor(score: number): Tier {
  if (score >= TIER_THRESHOLDS.S) return "S";
  if (score >= TIER_THRESHOLDS.A) return "A";
  if (score >= TIER_THRESHOLDS.B) return "B";
  return "C";
}

export function scoreAccount(company: Company, icp: Icp, signals: ScoredSignal[], today = new Date()): ScoreResult {
  const { fit, lines } = scoreFit(company, icp);
  const act = scoreActivity(signals, icp, today);
  const score = Math.round(0.45 * fit + 0.55 * act.activity);
  return { fit, fitBreakdown: lines, ...act, score, tier: tierFor(score) };
}
