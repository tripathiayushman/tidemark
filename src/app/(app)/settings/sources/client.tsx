"use client";

import { useTransition } from "react";
import { Loader2, Play, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runSourceNow } from "@/app/actions/network";
import { loadDemoDataAction } from "@/app/actions/knowledge";

export function RunSourceButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" size="xs" disabled={pending} onClick={() => start(async () => { const r = await runSourceNow(id); if (r.error) toast.error(r.error); else toast.success("Queued — the worker picks it up within a minute"); })}>
      {pending ? <Loader2 className="animate-spin" /> : <Play />} Run now
    </Button>
  );
}

export function DemoDataButton() {
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" disabled={pending} onClick={() => start(async () => { await loadDemoDataAction(); toast.success("Loading demo data — prospects appear as research finishes"); })}>
      {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} Load demo data
    </Button>
  );
}
