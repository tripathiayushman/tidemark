"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUp, Loader2, MessageSquarePlus, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/tm/markdown";

type Msg = { role: "user" | "assistant"; text: string; tools?: string[] };

const SUGGESTIONS = [
  "Who should I call this week, and why?",
  "Which tier S prospects have a warm intro?",
  "Where are the gaps in my targeting?",
  "Summarize the evidence for my top 3 prospects",
];

export function ChatView({ threads, threadId, initial }: { threads: { id: string; title: string }[]; threadId: string | null; initial: Msg[] }) {
  const router = useRouter();
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tid, setTid] = useState<string | null>(threadId);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [msgs]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }, { role: "assistant", text: "", tools: [] }]);
    const patchLast = (fn: (m: Msg) => Msg) => setMsgs((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: tid, message: text }) });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const line = p.replace(/^data: /, "");
          if (!line) continue;
          const ev = JSON.parse(line) as { type: string; text?: string; id?: string; label?: string; status?: string; message?: string };
          if (ev.type === "thread" && ev.id && ev.id !== tid) { setTid(ev.id); window.history.replaceState(null, "", `/chat?t=${ev.id}`); }
          if (ev.type === "text" && ev.text) patchLast((m) => ({ ...m, text: m.text + ev.text }));
          if (ev.type === "tool" && ev.status !== "start" && ev.label) patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), ev.label!] }));
          if (ev.type === "error") patchLast((m) => ({ ...m, text: m.text + `\n\n⚠️ ${ev.message}` }));
        }
      }
      router.refresh();
    } catch (e) {
      patchLast((m) => ({ ...m, text: `⚠️ ${(e as Error).message}` }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r lg:flex">
        <div className="p-3"><Button variant="outline" className="w-full justify-start" render={<Link href="/chat" />}><MessageSquarePlus /> New chat</Button></div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {threads.map((t) => (
            <Link key={t.id} href={`/chat?t=${t.id}`} className={cn("block truncate rounded-md px-2.5 py-1.5 text-sm", t.id === tid ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60")}>{t.title}</Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
            {!msgs.length ? (
              <div className="pt-16 text-center">
                <h1 className="text-2xl font-semibold tracking-tight">Ask about your prospects</h1>
                <p className="mt-2 text-sm text-muted-foreground">Tidemark looks up your prospects, their records, your ICP and your knowledge base to answer.</p>
                <div className="mx-auto mt-8 grid max-w-xl gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-xl border bg-card p-3 text-left text-sm hover:border-tide/50">{s}</button>)}
                </div>
              </div>
            ) : null}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">{m.text}</div>
                ) : (
                  <div className="space-y-2">
                    {m.tools?.length ? (
                      <div className="flex flex-wrap gap-1.5">{m.tools.map((t, j) => <span key={j} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"><Wrench className="size-3" />{t}</span>)}</div>
                    ) : null}
                    {m.text ? <Markdown text={m.text} /> : busy && i === msgs.length - 1 ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
                  </div>
                )}
              </div>
            ))}
            <div ref={end} />
          </div>
        </div>
        <form className="border-t p-4" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              rows={1}
              className="max-h-40 min-h-10 resize-none"
              placeholder="Ask about prospects, evidence, your ICP…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            />
            <Button type="submit" size="icon-lg" disabled={busy || !input.trim()} aria-label="Send">{busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
