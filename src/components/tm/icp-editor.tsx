"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { draftIcp, saveIcp, type IcpDraft } from "@/app/actions/icp";
import type { RoleTag, SignalCategory } from "@/lib/types";
import { ROLE_TAG_LABEL, SIGNAL_CATEGORY_LABEL } from "@/lib/types";

const EMPTY: IcpDraft = {
  name: "Primary",
  description: null,
  criteria: { industries: [], keywords: [], exclude_keywords: [], states: [], employee_min: null, employee_max: null },
  buyer_roles: [],
  signal_preferences: { weights: {}, lookback_days: 540, min_corroborating: 2 },
};

const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export function IcpEditor({ initial, onSaved, showDrafting = true }: { initial?: IcpDraft | null; onSaved?: () => void; showDrafting?: boolean }) {
  const router = useRouter();
  const [icp, setIcp] = useState<IcpDraft>(initial ?? EMPTY);
  const [best, setBest] = useState("");
  const [targets, setTargets] = useState("");
  const [drafting, startDraft] = useTransition();
  const [saving, startSave] = useTransition();
  const c = icp.criteria;
  const set = (patch: Partial<IcpDraft["criteria"]>) => setIcp((p) => ({ ...p, criteria: { ...p.criteria, ...patch } }));

  return (
    <div className="space-y-6">
      {showDrafting ? (
        <div className="rounded-xl border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-signal" /> Describe who buys from you</div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="best">Your best customers</Label>
              <Textarea id="best" rows={4} placeholder="e.g. Truck body and trailer plants, 100–800 people, in the Midwest, usually adding capacity or automating welding." value={best} onChange={(e) => setBest(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="targets">Companies like these (optional)</Label>
              <Textarea id="targets" rows={4} placeholder="One per line — current customers or dream accounts" value={targets} onChange={(e) => setTargets(e.target.value)} />
            </div>
          </div>
          <Button
            className="mt-3"
            variant="secondary"
            disabled={drafting}
            onClick={() =>
              startDraft(async () => {
                const r = await draftIcp({ bestCustomers: best, targetCompanies: targets });
                if (r.error || !r.draft) toast.error(r.error ?? "Could not draft an ICP");
                else {
                  setIcp({ ...r.draft, id: icp.id });
                  toast.success("Drafted from your knowledge base — review and save");
                }
              })
            }
          >
            {drafting ? <Loader2 className="animate-spin" /> : <Sparkles />} Draft my ICP
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="icp-name">Segment name</Label>
          <Input id="icp-name" value={icp.name} onChange={(e) => setIcp({ ...icp, name: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="icp-desc">Description</Label>
          <Input id="icp-desc" value={icp.description ?? ""} onChange={(e) => setIcp({ ...icp, description: e.target.value })} />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Industries (NAICS prefixes)</legend>
        <div className="space-y-2">
          {(c.industries ?? []).map((ind, i) => (
            <div key={i} className="flex gap-2">
              <Input className="w-28 font-mono" placeholder="3327" value={ind.naics_prefix} onChange={(e) => set({ industries: c.industries!.map((x, j) => (j === i ? { ...x, naics_prefix: e.target.value.replace(/\D/g, "") } : x)) })} />
              <Input placeholder="Machine shops" value={ind.label} onChange={(e) => set({ industries: c.industries!.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => set({ industries: c.industries!.filter((_, j) => j !== i) })}><Trash2 /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => set({ industries: [...(c.industries ?? []), { naics_prefix: "", label: "" }] })}><Plus /> Add industry</Button>
        </div>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label>Employees</Label>
          <div className="flex items-center gap-2">
            <Input type="number" placeholder="min" value={c.employee_min ?? ""} onChange={(e) => set({ employee_min: e.target.value ? Number(e.target.value) : null })} />
            <span className="text-muted-foreground">–</span>
            <Input type="number" placeholder="max" value={c.employee_max ?? ""} onChange={(e) => set({ employee_max: e.target.value ? Number(e.target.value) : null })} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="states">States (blank = nationwide)</Label>
          <Input id="states" placeholder="IN, OH, MI" defaultValue={(c.states ?? []).join(", ")} key={`s${(c.states ?? []).join()}`} onBlur={(e) => set({ states: list(e.target.value).map((s) => s.toUpperCase()) })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="kw">Fit keywords</Label>
          <Input id="kw" placeholder="welding, trailers, fabrication" defaultValue={(c.keywords ?? []).join(", ")} key={`k${(c.keywords ?? []).join()}`} onBlur={(e) => set({ keywords: list(e.target.value) })} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="xkw">Exclude if these appear</Label>
        <Input id="xkw" placeholder="distributor, reseller" defaultValue={(c.exclude_keywords ?? []).join(", ")} key={`x${(c.exclude_keywords ?? []).join()}`} onBlur={(e) => set({ exclude_keywords: list(e.target.value) })} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">People to reach</legend>
        {icp.buyer_roles.map((r, i) => (
          <div key={i} className="flex flex-wrap gap-2">
            <Input className="min-w-48 flex-1" placeholder="VP of Operations" value={r.title} onChange={(e) => setIcp({ ...icp, buyer_roles: icp.buyer_roles.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
            <select
              className="h-8 rounded-lg border bg-background px-2 text-sm"
              value={r.role_tag}
              onChange={(e) => setIcp({ ...icp, buyer_roles: icp.buyer_roles.map((x, j) => (j === i ? { ...x, role_tag: e.target.value as RoleTag } : x)) })}
            >
              {(Object.keys(ROLE_TAG_LABEL) as RoleTag[]).map((k) => <option key={k} value={k}>{ROLE_TAG_LABEL[k]}</option>)}
            </select>
            <Button variant="ghost" size="icon" aria-label="Remove role" onClick={() => setIcp({ ...icp, buyer_roles: icp.buyer_roles.filter((_, j) => j !== i) })}><Trash2 /></Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setIcp({ ...icp, buyer_roles: [...icp.buyer_roles, { title: "", role_tag: "decision_maker", title_keywords: [] }] })}><Plus /> Add role</Button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Which signals matter most</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {(Object.keys(SIGNAL_CATEGORY_LABEL) as SignalCategory[]).map((k) => {
            const v = icp.signal_preferences.weights?.[k] ?? 1;
            return (
              <label key={k} className="rounded-lg border bg-card p-3 text-sm">
                <span className="block font-medium">{SIGNAL_CATEGORY_LABEL[k]}</span>
                <input
                  type="range" min={0} max={2} step={0.25} value={v} className="mt-2 w-full accent-[var(--tide)]"
                  onChange={(e) => setIcp({ ...icp, signal_preferences: { ...icp.signal_preferences, weights: { ...icp.signal_preferences.weights, [k]: Number(e.target.value) } } })}
                />
                <span className="text-xs text-muted-foreground">{v === 0 ? "Ignore" : v < 1 ? "Less" : v === 1 ? "Normal" : "More"} ({v}×)</span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          A company needs at least{" "}
          <select
            className="rounded border bg-background px-1"
            value={icp.signal_preferences.min_corroborating ?? 2}
            onChange={(e) => setIcp({ ...icp, signal_preferences: { ...icp.signal_preferences, min_corroborating: Number(e.target.value) } })}
          >
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>{" "}
          independent records before it can become a prospect.
        </p>
      </fieldset>

      <div className="flex justify-end">
        <Button
          size="lg"
          disabled={saving || !(c.industries ?? []).every((i) => i.naics_prefix)}
          onClick={() =>
            startSave(async () => {
              const r = await saveIcp(icp);
              if (r.error) toast.error(r.error);
              else {
                setIcp((p) => ({ ...p, id: r.id }));
                toast.success("ICP saved — matching companies now");
                onSaved?.();
                router.refresh();
              }
            })
          }
        >
          {saving ? <Loader2 className="animate-spin" /> : null} Save ICP
        </Button>
      </div>
    </div>
  );
}
