import { Banknote, Building2, FileSignature, PackageOpen, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResearchStatus, SignalCategory, Tier, Verification } from "@/lib/types";
import { RESEARCH_STATUS_LABEL, SIGNAL_CATEGORY_LABEL } from "@/lib/types";

const TIER_STYLE: Record<Tier, string> = {
  S: "bg-tier-s text-white",
  A: "bg-tier-a text-white",
  B: "bg-tier-b text-white",
  C: "bg-tier-c text-foreground/80",
};

export function TierBadge({ tier, className }: { tier: Tier | null; className?: string }) {
  if (!tier) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      title={`Tier ${tier}`}
      className={cn("inline-flex size-6 items-center justify-center rounded-md text-xs font-semibold tabular-nums", TIER_STYLE[tier], className)}
    >
      {tier}
    </span>
  );
}

export const CATEGORY_ICON: Record<SignalCategory, typeof Banknote> = {
  money_moving: Banknote,
  building: Building2,
  equipment_supply: PackageOpen,
  contracts: FileSignature,
  operations: Truck,
};

export function CategoryChip({ category, className }: { category: SignalCategory; className?: string }) {
  const Icon = CATEGORY_ICON[category];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground", className)}>
      <Icon className="size-3" aria-hidden />
      {SIGNAL_CATEGORY_LABEL[category]}
    </span>
  );
}

const RESEARCH_STYLE: Record<ResearchStatus, string> = {
  queued: "text-muted-foreground",
  researching: "text-tide animate-pulse",
  checking: "text-tide animate-pulse",
  qualified: "text-tier-s font-medium",
  not_now: "text-muted-foreground",
  disqualified: "text-muted-foreground line-through decoration-muted-foreground/40",
  error: "text-destructive",
};

export function ResearchStatusText({ status }: { status: ResearchStatus }) {
  return <span className={cn("text-xs", RESEARCH_STYLE[status])}>{RESEARCH_STATUS_LABEL[status]}</span>;
}

export function VerifiedDot({ status }: { status: Verification }) {
  const map: Record<Verification, [string, string]> = {
    valid: ["bg-emerald-500", "Verified"],
    risky: ["bg-amber-500", "Risky — catch-all or unknown"],
    invalid: ["bg-red-500", "Invalid"],
    unverified: ["bg-muted-foreground/40", "Not verified"],
  };
  const [cls, label] = map[status];
  return <span title={label} aria-label={label} className={cn("inline-block size-1.5 rounded-full", cls)} />;
}

export function DemoTag() {
  return (
    <span title="Fictional demo company — not a real business" className="rounded border border-dashed border-signal/60 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-signal-foreground">
      Demo
    </span>
  );
}
