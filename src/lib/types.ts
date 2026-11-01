// Domain types shared by the worker, server actions and UI. They mirror the
// SQL schema in supabase/migrations (JSON column shapes are documented there).

export type SignalCategory = "money_moving" | "building" | "equipment_supply" | "contracts" | "operations";
export type RecordSource =
  | "usaspending" | "sba" | "permits" | "fmcsa" | "osha" | "customs"
  | "website" | "press" | "licensed" | "manual" | "seed"
  | "federal_register" | "ucc" | "warn" | "epa";
export type ResearchStatus = "queued" | "researching" | "checking" | "qualified" | "not_now" | "disqualified" | "error";
export type Tier = "S" | "A" | "B" | "C";
export type AccountStatus = "prospect" | "contacted" | "engaged" | "meeting" | "opportunity" | "customer" | "lost" | "archived";
export type Readiness = "ready_now" | "warming" | "later";
export type Confidence = "low" | "medium" | "high";
export type RoleTag = "decision_maker" | "runs_the_build" | "champion" | "influencer" | "other";
export type Verification = "unverified" | "valid" | "risky" | "invalid";
export type MemberRole = "owner" | "admin" | "member";
export type Provider = "hubspot" | "attio" | "gmail" | "granola" | "instantly";

export const SIGNAL_CATEGORY_LABEL: Record<SignalCategory, string> = {
  money_moving: "Money moving",
  building: "Building",
  equipment_supply: "Equipment and supply",
  contracts: "Contracts",
  operations: "Operations",
};

export const ROLE_TAG_LABEL: Record<RoleTag, string> = {
  decision_maker: "Decision maker",
  runs_the_build: "Runs the build",
  champion: "Champion",
  influencer: "Influencer",
  other: "Contact",
};

export const READINESS_LABEL: Record<Readiness, string> = {
  ready_now: "Ready now",
  warming: "Warming",
  later: "Later",
};

export const RESEARCH_STATUS_LABEL: Record<ResearchStatus, string> = {
  queued: "Queued",
  researching: "Researching…",
  checking: "Checking…",
  qualified: "Yes",
  not_now: "Not yet",
  disqualified: "No",
  error: "Error",
};

// ── ICP JSON shapes ─────────────────────────────────────────────────────────
export interface IcpIndustry {
  naics_prefix: string; // "3363" matches 336390 etc.
  label: string;
}

export interface IcpCriteria {
  industries?: IcpIndustry[];
  keywords?: string[];
  exclude_keywords?: string[];
  employee_min?: number | null;
  employee_max?: number | null;
  revenue_min?: number | null;
  revenue_max?: number | null;
  states?: string[];
  exclude_states?: string[];
}

export interface BuyerRole {
  title: string;               // "VP of Operations"
  role_tag: RoleTag;
  seniority?: string;          // owner | c_suite | vp | director | manager
  departments?: string[];
  title_keywords?: string[];   // ["operations", "plant", "manufacturing"]
}

export interface SignalPreferences {
  weights?: Partial<Record<SignalCategory, number>>; // 0..2, default 1
  lookback_days?: number;      // default 540
  min_corroborating?: number;  // default 2 distinct records
}

export interface Icp {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  is_primary: boolean;
  is_active: boolean;
  criteria: IcpCriteria;
  buyer_roles: BuyerRole[];
  signal_preferences: SignalPreferences;
}

// ── Rows ────────────────────────────────────────────────────────────────────
export interface Company {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  naics_code: string | null;
  naics_title: string | null;
  industry: string | null;
  employee_count: number | null;
  annual_revenue: number | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  linkedin_url: string | null;
  phone: string | null;
  is_synthetic: boolean;
}

export interface Signal {
  id: string;
  company_id: string;
  source_record_id: string | null;
  category: SignalCategory;
  signal_type: string;
  title: string;
  detail: string | null;
  occurred_on: string; // YYYY-MM-DD
  amount: number | null;
  quantity: number | null;
  unit: string | null;
  location: string | null;
  source: RecordSource;
  source_url: string | null;
  attributes: Record<string, unknown>;
  strength: number;
  is_synthetic: boolean;
}

export interface Account {
  id: string;
  workspace_id: string;
  company_id: string;
  icp_id: string | null;
  research_status: ResearchStatus;
  fit_score: number | null;
  fit_breakdown: ScoreLine[] | null;
  activity_score: number | null;
  activity_breakdown: ScoreLine[] | null;
  score: number | null;
  tier: Tier | null;
  confidence: Confidence | null;
  reason_to_buy: string | null;
  reason_category: string | null;
  why: string | null;
  reasoning: string | null;
  timing_label: string | null;
  readiness: Readiness | null;
  contact_window_start: string | null;
  contact_window_end: string | null;
  next_step: string | null;
  status: AccountStatus;
  owner_id: string | null;
  qualified_at: string | null;
  last_researched_at: string | null;
  last_signal_on: string | null;
  signals_fingerprint: string | null;
  research_error: string | null;
}

export interface ScoreLine {
  criterion: string;
  score: number;   // 0..100
  weight: number;  // relative
  note: string;
}

export interface Contact {
  id: string;
  workspace_id: string;
  company_id: string | null;
  account_id: string | null;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  role_tag: RoleTag;
  email: string | null;
  email_status: Verification;
  phone: string | null;
  phone_status: Verification;
  linkedin_url: string | null;
  location: string | null;
  source: string;
  unsubscribed_at: string | null;
}

export interface SellerProfile {
  workspace_id: string;
  summary: string | null;
  offerings: { name: string; description: string }[];
  buyer_problems: string[];
  proof_points: string[];
  differentiators: string[];
  competitors: string[];
  buying_triggers: string[];
}
