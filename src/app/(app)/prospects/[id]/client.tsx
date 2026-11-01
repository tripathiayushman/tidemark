"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ListPlus, Loader2, RefreshCw, Send, UploadCloud, UserPlus, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { addContact, addNote, addToList, createTask, findContacts, pushToCrm, reResearch, setAccountOwner, setAccountStatus } from "@/app/actions/accounts";
import type { AccountStatus } from "@/lib/types";
import { ROLE_TAG_LABEL } from "@/lib/types";

const STATUSES: AccountStatus[] = ["prospect", "contacted", "engaged", "meeting", "opportunity", "customer", "lost", "archived"];
const sel = "h-8 rounded-lg border bg-background px-2 text-sm";

export function ProfileActions({ accountId, status, ownerId, members, lists }: { accountId: string; status: AccountStatus; ownerId: string | null; members: { id: string; name: string }[]; lists: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<unknown>, ok?: string) => start(async () => {
    try {
      const r = (await fn()) as { error?: string } | undefined;
      if (r?.error) toast.error(r.error);
      else { if (ok) toast.success(ok); router.refresh(); }
    } catch (e) { toast.error((e as Error).message); }
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={sel} aria-label="Status" value={status} onChange={(e) => run(() => setAccountStatus(accountId, e.target.value as AccountStatus))}>
        {STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
      </select>
      <select className={sel} aria-label="Owner" value={ownerId ?? ""} onChange={(e) => run(() => setAccountOwner(accountId, e.target.value || null))}>
        <option value="">Unassigned</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <ListDialog accountId={accountId} lists={lists} />
      <TaskDialog accountId={accountId} />
      <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => pushToCrm([accountId]), "Queued for CRM sync")}><UploadCloud /> Push to CRM</Button>
      <Button variant="outline" size="sm" onClick={() => router.push(`/campaigns?add=${accountId}`)}><Send /> Add to campaign</Button>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => reResearch(accountId), "Re-researching")}>
        {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-research
      </Button>
    </div>
  );
}

function ListDialog({ accountId, lists }: { accountId: string; lists: string[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}><ListPlus /> List{lists.length ? ` · ${lists.length}` : ""}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add to a list</DialogTitle></DialogHeader>
        {lists.length ? <p className="text-sm text-muted-foreground">On: {lists.join(", ")}</p> : null}
        <Input placeholder="List name, e.g. Q1 expansion plays" value={name} onChange={(e) => setName(e.target.value)} />
        <DialogFooter>
          <Button disabled={pending || !name.trim()} onClick={() => start(async () => {
            const r = await addToList([accountId], name);
            if (r.error) toast.error(r.error); else { toast.success(`Added to ${name}`); setOpen(false); setName(""); router.refresh(); }
          })}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskDialog({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}><Plus /> Task</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New task</DialogTitle></DialogHeader>
        <Input placeholder="Call the plant manager about install timing" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <DialogFooter>
          <Button disabled={pending || !title.trim()} onClick={() => start(async () => {
            const r = await createTask({ accountId, title, dueOn: due || null, kind: "reach_out" });
            if (r.error) toast.error(r.error); else { toast.success("Task added"); setOpen(false); setTitle(""); router.refresh(); }
          })}>Add task</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ContactActions({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ full_name: "", title: "", email: "", phone: "", role_tag: "decision_maker" });
  return (
    <div className="flex gap-1">
      <Button variant="ghost" size="xs" disabled={pending} onClick={() => start(async () => { await findContacts(accountId); toast.success("Looking for contacts"); router.refresh(); })}>
        {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Find
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button variant="ghost" size="xs" />}><UserPlus /> Add</DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle>Add a contact</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Input placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            <Input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <Input placeholder="Work email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <select className={sel} value={form.role_tag} onChange={(e) => setForm({ ...form, role_tag: e.target.value })}>
              {Object.entries(ROLE_TAG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button disabled={!form.full_name.trim()} onClick={() => start(async () => {
              const r = await addContact(accountId, form);
              if (r.error) toast.error(r.error); else { setOpen(false); router.refresh(); }
            })}>Save contact</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function NoteForm({ accountId }: { accountId: string }) {
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); start(async () => { await addNote(accountId, text); setText(""); router.refresh(); }); }}>
      <Textarea rows={2} placeholder="Add a note…" value={text} onChange={(e) => setText(e.target.value)} />
      <Button type="submit" size="sm" disabled={pending || !text.trim()}>Save</Button>
    </form>
  );
}
