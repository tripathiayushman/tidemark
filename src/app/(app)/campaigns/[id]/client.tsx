"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { enrollAccounts, saveSteps, setCampaignStatus, skipDraft, stopEnrollment, updateCampaignSettings, updateDraft } from "@/app/actions/campaigns";
import { cn } from "@/lib/utils";

export function CampaignControls({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = (s: "active" | "paused" | "archived") => start(async () => { const r = await setCampaignStatus(id, s); if (r.error) toast.error(r.error); else router.refresh(); });
  return (
    <div className="flex gap-2">
      {status === "active" ? (
        <Button variant="outline" disabled={pending} onClick={() => go("paused")}><Pause /> Pause</Button>
      ) : (
        <Button disabled={pending} onClick={() => go("active")}>{pending ? <Loader2 className="animate-spin" /> : <Play />} {status === "paused" ? "Resume" : "Launch"}</Button>
      )}
      <Button variant="ghost" disabled={pending} onClick={() => { if (confirm("Archive this campaign? Active sequences stop.")) go("archived"); }}>Archive</Button>
    </div>
  );
}

type Step = { position: number; delay_days: number; subject_template: string; body_template: string; ai_draft: boolean };

export function StepsEditor({ campaignId, initial }: { campaignId: string; initial: Step[] }) {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(initial.length ? initial : [{ position: 0, delay_days: 0, subject_template: "", body_template: "", ai_draft: true }]);
  const [pending, start] = useTransition();
  const upd = (i: number, p: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-3">
      {steps.map((s, i) => (
        <div key={i} className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">{i === 0 ? "First email" : `Follow-up ${i}`}</span>
            <div className="flex items-center gap-3 text-xs">
              {i > 0 ? <label className="flex items-center gap-1.5">wait <Input type="number" min={1} className="h-7 w-14" value={s.delay_days} onChange={(e) => upd(i, { delay_days: Number(e.target.value) })} /> days</label> : null}
              <label className="flex items-center gap-1.5"><Switch checked={s.ai_draft} onCheckedChange={(v) => upd(i, { ai_draft: v })} /> Draft from records</label>
              {i > 0 ? <Button variant="ghost" size="icon-xs" aria-label="Remove step" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}><Trash2 /></Button> : null}
            </div>
          </div>
          {!s.ai_draft && i === 0 ? <Input className="mt-3" placeholder="Subject — {{first_name}}, {{company}} work" value={s.subject_template} onChange={(e) => upd(i, { subject_template: e.target.value })} /> : null}
          <Textarea className="mt-3" rows={3} placeholder={s.ai_draft ? "Guidance for the draft (optional): angle, proof point, ask" : "Email body — {{first_name}}, {{company}} work"} value={s.body_template} onChange={(e) => upd(i, { body_template: e.target.value })} />
          {i > 0 ? <p className="mt-1 text-xs text-muted-foreground">Sent as a reply in the same thread. Stops automatically on reply, bounce or unsubscribe.</p> : null}
        </div>
      ))}
      <div className="flex justify-between">
        <Button variant="outline" size="sm" disabled={steps.length >= 5} onClick={() => setSteps((s) => [...s, { position: s.length, delay_days: 3, subject_template: "", body_template: "", ai_draft: true }])}><Plus /> Add follow-up</Button>
        <Button size="sm" disabled={pending} onClick={() => start(async () => { const r = await saveSteps(campaignId, steps); if (r.error) toast.error(r.error); else { toast.success("Sequence saved"); router.refresh(); } })}>Save sequence</Button>
      </div>
    </div>
  );
}

export function CampaignSettings({ id, days, start: s0, end: e0, timezone, cap }: { id: string; days: number[]; start: string; end: string; timezone: string; cap: number }) {
  const [sel, setSel] = useState<number[]>(days);
  const [start, setStart] = useState(s0);
  const [end, setEnd] = useState(e0);
  const [limit, setLimit] = useState(cap);
  const [pending, run] = useTransition();
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 text-sm">
      <div>
        <Label>Weekdays</Label>
        <div className="mt-1.5 flex gap-1">
          {["Mon", "Tue", "Wed", "Thu", "Fri"].map((d, i) => (
            <button key={d} type="button" onClick={() => setSel((x) => (x.includes(i + 1) ? x.filter((y) => y !== i + 1) : [...x, i + 1].sort()))} className={cn("rounded-md border px-2 py-1 text-xs", sel.includes(i + 1) ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}>{d}</button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Never on weekends.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1"><Label htmlFor="ws">From</Label><Input id="ws" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="we">Until</Label><Input id="we" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>
      <p className="text-xs text-muted-foreground">{timezone}</p>
      <div className="space-y-1"><Label htmlFor="cap">Daily cap (max 40 per mailbox)</Label><Input id="cap" type="number" min={1} max={40} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></div>
      <Button size="sm" disabled={pending || !sel.length || end <= start} onClick={() => run(async () => {
        const r = await updateCampaignSettings(id, { sending_days: sel, send_window_start: start, send_window_end: end, daily_cap: limit });
        if (r.error) toast.error(r.error); else toast.success("Saved");
      })}>Save rules</Button>
    </div>
  );
}

export function DraftEditor({ id, to, step, subject, body }: { id: string; to: string; step: number; subject: string; body: string }) {
  const [s, setS] = useState(subject);
  const [b, setB] = useState(body);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-2 text-xs text-muted-foreground">To {to} · {step === 0 ? "first email" : `follow-up ${step}`}</div>
      {step === 0 ? <Input value={s} onChange={(e) => setS(e.target.value)} aria-label="Subject" className="mb-2" /> : null}
      <Textarea rows={6} value={b} onChange={(e) => setB(e.target.value)} aria-label="Body" />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(async () => { await skipDraft(id); router.refresh(); })}>Skip</Button>
        <Button size="sm" disabled={pending} onClick={() => start(async () => { const r = await updateDraft(id, s, b); if (r.error) toast.error(r.error); else toast.success("Draft saved"); })}>Save</Button>
      </div>
    </div>
  );
}

export function StopButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <Button variant="ghost" size="xs" disabled={pending} onClick={() => start(async () => { await stopEnrollment(id); router.refresh(); })}>Stop</Button>;
}

export function BulkEnroll({ campaignId, prospects }: { campaignId: string; prospects: { id: string; name: string; tier: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="xs" />}><UserPlus /> Add prospects</DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Add prospects</DialogTitle></DialogHeader>
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {prospects.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
                <span className="w-6 text-xs font-semibold">{p.tier}</span>{p.name}
              </label>
            </li>
          ))}
          {!prospects.length ? <li className="text-sm text-muted-foreground">Every qualified prospect is already enrolled.</li> : null}
        </ul>
        <DialogFooter>
          <Button disabled={pending || !picked.length} onClick={() => start(async () => {
            const r = await enrollAccounts(campaignId, picked);
            if (r.error) toast.error(r.error); else { toast.success(`Enrolled ${r.enrolled}`); setOpen(false); setPicked([]); router.refresh(); }
          })}>{pending ? <Loader2 className="animate-spin" /> : null}Enroll {picked.length || ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
