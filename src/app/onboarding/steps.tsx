"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { KnowledgeUploader } from "@/components/tm/knowledge-uploader";
import { IcpEditor } from "@/components/tm/icp-editor";
import { createWorkspace, setOnboardingStep } from "@/app/actions/workspace";
import { loadDemoDataAction } from "@/app/actions/knowledge";

export function CompanyStep() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold tracking-tight">Tell us about your company</h1>
      <p className="mt-2 text-sm text-muted-foreground">Tidemark learns what you sell, then watches public records for manufacturers that need it.</p>
      <form
        className="mt-8 space-y-4"
        action={(fd) =>
          start(async () => {
            const r = await createWorkspace(fd);
            if (r.error) toast.error(r.error);
            else router.refresh();
          })
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="name">Company name</Label>
          <Input id="name" name="name" required placeholder="Acme Automation" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="website">Website</Label>
          <Input id="website" name="website" placeholder="acmeautomation.com" />
        </div>
        <Button type="submit" size="lg" disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : null}Continue</Button>
      </form>
    </div>
  );
}

export function KnowledgeStep({ website, docs }: { website: string | null; docs: { id: string; name: string; status: string; kind: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const processing = docs.some((d) => d.status === "queued" || d.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [processing, router]);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Teach Tidemark what you sell</h1>
      <p className="mt-2 text-sm text-muted-foreground">Add your site and any documents. Tidemark reads them to learn your offering, who buys it, and which events create the need.</p>
      <div className="mt-8"><KnowledgeUploader defaultWebsite={website} /></div>
      {docs.length ? (
        <ul className="mt-6 divide-y rounded-xl border bg-card">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="truncate">{d.name}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {d.status === "ready" ? <CheckCircle2 className="size-4 text-emerald-600" /> : d.status === "failed" ? <XCircle className="size-4 text-destructive" /> : <Loader2 className="size-4 animate-spin" />}
                {d.status === "ready" ? "Ready" : d.status === "failed" ? "Failed" : "Reading…"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-8 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{processing ? "Reading in the background — you can continue." : "You can add more later in Knowledge."}</p>
        <Button size="lg" disabled={pending} onClick={() => start(async () => { await setOnboardingStep("icp"); router.refresh(); })}>
          {pending ? <Loader2 className="animate-spin" /> : null}Continue
        </Button>
      </div>
    </div>
  );
}

export function IcpStep({ hasSeller }: { hasSeller: boolean }) {
  const router = useRouter();
  const [demo, setDemo] = useState(true);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Who buys from you?</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasSeller ? "Tidemark has read your materials. Describe your best customers and it drafts your ideal customer profile." : "Your documents are still being read — you can describe your customers now and refine the profile later."}
      </p>
      <div className="mt-8"><IcpEditor onSaved={() => setSaved(true)} /></div>
      <div className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={demo} onCheckedChange={setDemo} />
          <span>
            <span className="font-medium">Add demo data</span>
            <span className="block text-xs text-muted-foreground">120 fictional manufacturers with realistic timelines, clearly marked “Demo”. Real public records load in the background either way.</span>
          </span>
        </label>
        <Button
          size="lg"
          disabled={!saved || pending}
          onClick={() =>
            start(async () => {
              if (demo) await loadDemoDataAction();
              await setOnboardingStep("done");
              router.push("/home");
            })
          }
        >
          {pending ? <Loader2 className="animate-spin" /> : null}{saved ? "Find my prospects" : "Save your ICP first"}
        </Button>
      </div>
    </div>
  );
}
