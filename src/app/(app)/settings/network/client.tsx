"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { importLinkedInConnections, removeMyLinkedInConnections } from "@/app/actions/network";

export function LinkedInUpload({ hasImport, count }: { hasImport: boolean; count: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={pending} onClick={() => input.current?.click()}>{pending ? <Loader2 className="animate-spin" /> : <Upload />} {hasImport ? "Upload a newer export" : "Upload Connections.csv"}</Button>
      {hasImport ? (
        <>
          <span className="text-sm text-muted-foreground">{count.toLocaleString()} connections imported</span>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(async () => { await removeMyLinkedInConnections(); toast.success("Removed"); router.refresh(); })}>Remove mine</Button>
        </>
      ) : null}
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          start(async () => {
            const r = await importLinkedInConnections(await f.text());
            if (r.error) toast.error(r.error);
            else { toast.success(`Imported ${r.imported} connections — finding warm paths`); router.refresh(); }
          });
        }}
      />
    </div>
  );
}
