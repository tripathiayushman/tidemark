"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createCampaign, enrollAccounts } from "@/app/actions/campaigns";
import { instantlyCampaigns } from "@/app/actions/integrations";

const sel = "h-8 w-full rounded-lg border bg-background px-2 text-sm";

export function NewCampaignButton({ mailboxes, instantlyConnectionId }: { mailboxes: { id: string; label: string }[]; instantlyConnectionId: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<"gmail" | "instantly">(mailboxes.length ? "gmail" : "instantly");
  const [mailbox, setMailbox] = useState(mailboxes[0]?.id ?? "");
  const [ic, setIc] = useState<{ id: string; name: string; status: string }[]>([]);
  const [icId, setIcId] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open || channel !== "instantly" || !instantlyConnectionId) return;
    instantlyCampaigns(instantlyConnectionId).then((r) => { if (r.error) toast.error(r.error); setIc(r.campaigns); setIcId(r.campaigns[0]?.id ?? ""); });
  }, [open, channel, instantlyConnectionId]);

  const disabled = !mailboxes.length && !instantlyConnectionId;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" disabled={disabled} />}><Plus /> New campaign</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New campaign</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="cname">Name</Label><Input id="cname" placeholder="Expansion plays — Midwest" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label>Send through</Label>
            <select className={sel} value={channel} onChange={(e) => setChannel(e.target.value as "gmail" | "instantly")}>
              {mailboxes.length ? <option value="gmail">Gmail (from your mailbox)</option> : null}
              {instantlyConnectionId ? <option value="instantly">Instantly</option> : null}
            </select>
          </div>
          {channel === "gmail" ? (
            <div className="space-y-1.5">
              <Label>Mailbox</Label>
              <select className={sel} value={mailbox} onChange={(e) => setMailbox(e.target.value)}>{mailboxes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
              <p className="text-xs text-muted-foreground">Sending must be switched on for this mailbox in Settings → Integrations.</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Instantly campaign</Label>
              <select className={sel} value={icId} onChange={(e) => setIcId(e.target.value)}>
                {ic.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.status}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">Use {"{{tidemark_subject}}"} and {"{{tidemark_body}}"} in the Instantly template — Tidemark fills them per prospect.</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button disabled={pending || !name.trim()} onClick={() => start(async () => {
            const r = await createCampaign({ name, channel, mailboxConnectionId: channel === "gmail" ? mailbox : null, instantlyConnectionId: channel === "instantly" ? instantlyConnectionId : null, instantlyCampaignId: channel === "instantly" ? icId : null });
            if (r.error) toast.error(r.error); else { setOpen(false); router.push(`/campaigns/${r.id}`); }
          })}>{pending ? <Loader2 className="animate-spin" /> : null}Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddToCampaignDialog({ accountId, campaigns }: { accountId: string; campaigns: { id: string; name: string; channel: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [cid, setCid] = useState(campaigns[0]?.id ?? "");
  const [pending, start] = useTransition();
  const close = (v: boolean) => { setOpen(v); if (!v) router.replace("/campaigns"); };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add prospect to a campaign</DialogTitle></DialogHeader>
        {campaigns.length ? (
          <select className={sel} value={cid} onChange={(e) => setCid(e.target.value)}>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.channel})</option>)}</select>
        ) : <p className="text-sm text-muted-foreground">Create a campaign first.</p>}
        <p className="text-xs text-muted-foreground">Tidemark enrolls the best contact (decision maker first) with a usable email, and drafts the first email from this prospect&apos;s records.</p>
        <DialogFooter>
          <Button disabled={pending || !cid} onClick={() => start(async () => {
            const r = await enrollAccounts(cid, [accountId]);
            if (r.error) toast.error(r.error); else { toast.success(`Enrolled ${r.enrolled}`); router.push(`/campaigns/${cid}`); }
          })}>{pending ? <Loader2 className="animate-spin" /> : null}Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
