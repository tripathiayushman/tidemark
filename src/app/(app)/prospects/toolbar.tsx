"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const selectCls = "h-8 rounded-lg border bg-background px-2 text-sm text-foreground";

export function ProspectToolbar({ tab, icps }: { tab: string; icps: { id: string; name: string }[] }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  const update = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    p.delete("page");
    router.replace(`${path}?${p}`);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== q) update({ q: q || null });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const anyFilter = ["q", "tier", "status", "icp", "sort"].some((k) => params.get(k));
  return (
    <div className="flex flex-wrap items-center gap-2 py-3">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" placeholder="Search prospects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search prospects" />
      </div>
      <select className={selectCls} aria-label="Tier" value={params.get("tier") ?? ""} onChange={(e) => update({ tier: e.target.value || null })}>
        <option value="">All tiers</option>
        {["S", "A", "B", "C"].map((t) => <option key={t} value={t}>Tier {t}</option>)}
      </select>
      {tab === "watching" ? (
        <select className={selectCls} aria-label="Research status" value={params.get("status") ?? ""} onChange={(e) => update({ status: e.target.value || null })}>
          <option value="">Any status</option>
          <option value="queued">Queued</option>
          <option value="researching">Researching</option>
          <option value="checking">Checking</option>
          <option value="qualified">Qualified</option>
          <option value="not_now">Not yet</option>
          <option value="disqualified">Outside ICP</option>
          <option value="error">Error</option>
        </select>
      ) : (
        <select className={selectCls} aria-label="Status" value={params.get("status") ?? ""} onChange={(e) => update({ status: e.target.value || null })}>
          <option value="">Any status</option>
          {["prospect", "contacted", "engaged", "meeting", "opportunity", "customer", "lost"].map((s) => <option key={s} value={s} className="capitalize">{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
      )}
      {icps.length > 1 ? (
        <select className={selectCls} aria-label="Segment" value={params.get("icp") ?? ""} onChange={(e) => update({ icp: e.target.value || null })}>
          <option value="">All segments</option>
          {icps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      ) : null}
      <select className={selectCls} aria-label="Sort" value={params.get("sort") ?? ""} onChange={(e) => update({ sort: e.target.value || null })}>
        <option value="">{tab === "watching" ? "Latest record" : "Best fit + timing"}</option>
        <option value="window">Window closing soonest</option>
        <option value="recent">Newest qualified</option>
        <option value="signal">Latest record</option>
        <option value="name">Name A–Z</option>
      </select>
      {anyFilter ? (
        <Button variant="ghost" size="sm" onClick={() => { setQ(""); router.replace(`${path}${tab !== "all" ? `?tab=${tab}` : ""}`); }}>
          <X /> Clear
        </Button>
      ) : null}
    </div>
  );
}
