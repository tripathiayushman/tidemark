"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MoreHorizontal, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { deleteDocument, refreshSellerProfile, reprocessDocument, updateSellerProfile } from "@/app/actions/knowledge";
import type { SellerProfile } from "@/lib/types";

export function DocActions({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="File actions" disabled={pending} />}>
        {pending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={() => start(async () => { await reprocessDocument(id); router.refresh(); })}>Re-read</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => start(async () => { await deleteDocument(id); toast.success("Removed"); router.refresh(); })}>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RefreshButton() {
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => { await refreshSellerProfile(); toast.success("Rebuilding your profile from the knowledge base"); })}>
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
    </Button>
  );
}

export function SellerProfileForm({ profile }: { profile: SellerProfile | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!profile?.summary) {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Sparkles className="size-4 text-signal" /> Tidemark writes this once it has read your website or documents.</p>;
  }
  const field = (name: keyof SellerProfile, label: string, rows = 3) => (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Textarea id={name} name={name} rows={rows} defaultValue={Array.isArray(profile[name]) ? (profile[name] as string[]).join("\n") : String(profile[name] ?? "")} />
    </div>
  );
  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      action={(fd) => start(async () => { const r = await updateSellerProfile(fd); if (r.error) toast.error(r.error); else { toast.success("Saved"); router.refresh(); } })}
    >
      <div className="md:col-span-2">{field("summary", "What you sell, to whom", 3)}</div>
      {profile.offerings?.length ? (
        <div className="md:col-span-2">
          <Label>Offerings</Label>
          <ul className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {profile.offerings.map((o, i) => <li key={i} className="rounded-lg border bg-card p-3 text-sm"><span className="font-medium">{o.name}</span><span className="block text-muted-foreground">{o.description}</span></li>)}
          </ul>
        </div>
      ) : null}
      {field("buying_triggers", "Events that create need (one per line)", 5)}
      {field("buyer_problems", "Problems you solve (one per line)", 5)}
      {field("proof_points", "Proof points", 4)}
      {field("differentiators", "Differentiators", 4)}
      <div className="md:col-span-2 flex justify-end"><Button type="submit" disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : null}Save</Button></div>
    </form>
  );
}
