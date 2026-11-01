"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dismissInsight, regenerateInsights } from "@/app/actions/insights";

export function RegenerateButton() {
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => { await regenerateInsights(); toast.success("Regenerating — refresh in a minute"); })}>
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Regenerate
    </Button>
  );
}

export function InsightActions({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button aria-label="Dismiss insight" disabled={pending} className="text-muted-foreground hover:text-foreground" onClick={() => start(async () => { await dismissInsight(id); router.refresh(); })}>
      <X className="size-4" />
    </button>
  );
}
