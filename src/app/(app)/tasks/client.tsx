"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createTask, setTaskStatus } from "@/app/actions/accounts";
import { cn } from "@/lib/utils";

export function TaskRowActions({ id, done }: { id: string; done: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-1 pt-0.5">
      <button
        aria-label={done ? "Reopen" : "Mark done"}
        disabled={pending}
        onClick={() => start(async () => { await setTaskStatus(id, done ? "open" : "done"); router.refresh(); })}
        className={cn("flex size-5 items-center justify-center rounded border transition-colors", done ? "border-tide bg-tide text-white" : "hover:border-tide")}
      >
        {done ? <Check className="size-3.5" /> : null}
      </button>
      {!done ? (
        <button aria-label="Dismiss" title="Dismiss" disabled={pending} onClick={() => start(async () => { await setTaskStatus(id, "dismissed"); router.refresh(); })} className="text-muted-foreground/60 hover:text-foreground">
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function NewTaskButton() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}><Plus /> New task</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New task</DialogTitle></DialogHeader>
        <Input placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <DialogFooter>
          <Button disabled={pending || !title.trim()} onClick={() => start(async () => {
            const r = await createTask({ title, dueOn: due || null });
            if (r.error) toast.error(r.error); else { setOpen(false); setTitle(""); setDue(""); router.refresh(); }
          })}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
