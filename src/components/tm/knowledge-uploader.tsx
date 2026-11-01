"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { addWebsite, prepareUpload, registerUploads } from "@/app/actions/knowledge";
import { cn } from "@/lib/utils";

const ACCEPT = ".pdf,.docx,.csv,.tsv,.txt,.md,.html,.htm,.json";

export function KnowledgeUploader({ defaultWebsite, compact = false }: { defaultWebsite?: string | null; compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [site, setSite] = useState(defaultWebsite ?? "");
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  async function upload(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    try {
      const prep = await prepareUpload(files.map((f) => ({ name: f.name, size: f.size })));
      if ("error" in prep && prep.error) throw new Error(prep.error);
      const ws = (prep as { workspaceId: string }).workspaceId;
      const supabase = createClient();
      const done: { id: string; name: string; size: number; mime: string; path: string }[] = [];
      for (const f of files) {
        const id = crypto.randomUUID();
        const safe = f.name.replace(/[^\w.\- ]+/g, "_");
        const path = `${ws}/${id}/${safe}`;
        const { error } = await supabase.storage.from("knowledge").upload(path, f, { contentType: f.type || undefined, upsert: false });
        if (error) throw new Error(`${f.name}: ${error.message}`);
        done.push({ id, name: f.name, size: f.size, mime: f.type, path });
      }
      const res = await registerUploads(done);
      if ("error" in res && res.error) throw new Error(res.error);
      toast.success(`${done.length} file${done.length > 1 ? "s" : ""} added — reading now`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("grid gap-4", compact ? "" : "md:grid-cols-2")}>
      <form
        className="rounded-xl border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await addWebsite(site);
            if (r.error) toast.error(r.error);
            else {
              toast.success("Reading your website");
              router.refresh();
            }
          });
        }}
      >
        <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Globe className="size-4 text-tide" /> Your website</div>
        <p className="mb-3 text-xs text-muted-foreground">We read your homepage and a few pages about products, industries and customers.</p>
        <div className="flex gap-2">
          <Input placeholder="yourcompany.com" value={site} onChange={(e) => setSite(e.target.value)} />
          <Button type="submit" disabled={pending || !site.trim()}>{pending ? <Loader2 className="animate-spin" /> : null}Read</Button>
        </div>
      </form>

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload([...e.dataTransfer.files]); }}
        className={cn("flex flex-col justify-center rounded-xl border border-dashed bg-card p-4 transition-colors", drag && "border-tide bg-accent/50")}
      >
        <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Upload className="size-4 text-tide" /> Documents</div>
        <p className="mb-3 text-xs text-muted-foreground">Sales playbooks, product overviews, case studies, customer lists. PDF, DOCX, CSV, TXT, MD.</p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />} Upload files
          </Button>
          <span className="text-xs text-muted-foreground">or drag and drop</span>
        </div>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => upload([...(e.target.files ?? [])])} />
      </div>
    </div>
  );
}
