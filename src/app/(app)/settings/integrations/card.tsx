"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plug, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { disconnectIntegration, syncNow, updateGmailSettings } from "@/app/actions/integrations";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ConnectionView {
  id: string;
  provider: string;
  status: "active" | "error" | "disconnected";
  account_label: string | null;
  last_synced_at: string | null;
  error: string | null;
  settings: { sending_enabled?: boolean; prospect_scope?: "qualified" | "owned" } & Record<string, unknown>;
  scopes: string[];
  connected_by: string | null;
}

export function IntegrationCard({
  provider, connections, canAdmin, userId,
}: {
  provider: { id: string; name: string; kind: "oauth" | "apikey"; blurb: string; rules: string[]; perMember: boolean; adminOnly: boolean; configured: boolean };
  connections: ConnectionView[];
  canAdmin: boolean;
  userId: string;
}) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [pending, start] = useTransition();
  const mine = connections.find((c) => c.connected_by === userId);
  const canConnect = provider.configured && (!provider.adminOnly || canAdmin) && (provider.perMember ? !mine : connections.length === 0);

  const connectKey = () => start(async () => {
    const res = await fetch("/api/integrations/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: provider.id, apiKey: key }) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!body.ok) toast.error(body.error ?? `Could not connect (${res.status})`);
    else { toast.success(`${provider.name} connected`); setKey(""); router.refresh(); }
  });

  return (
    <div className="flex flex-col rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{provider.name}</h3>
        {connections.some((c) => c.status === "active") ? <span className="inline-flex items-center gap-1 text-xs text-tier-s"><Check className="size-3.5" /> Connected</span> : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{provider.blurb}</p>
      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
        {provider.rules.map((r) => <li key={r} className="flex gap-1.5"><span className="text-tide">•</span>{r}</li>)}
      </ul>

      <div className="mt-4 space-y-3">
        {connections.map((c) => (
          <div key={c.id} className={cn("rounded-lg border p-3 text-sm", c.status === "error" && "border-destructive/50")}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{c.account_label ?? provider.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{c.last_synced_at ? `synced ${ago(c.last_synced_at)}` : "not synced yet"}</span>
            </div>
            {c.error ? <p className="mt-1 text-xs text-destructive">{c.error}</p> : null}
            {provider.id === "gmail" && c.connected_by === userId ? <GmailControls conn={c} /> : null}
            <div className="mt-2 flex gap-2">
              {provider.id !== "instantly" ? (
                <Button variant="outline" size="xs" disabled={pending} onClick={() => start(async () => { const r = await syncNow(c.id); if (r.error) toast.error(r.error); else toast.success("Syncing"); })}><RefreshCw /> Sync now</Button>
              ) : null}
              {(canAdmin || c.connected_by === userId) ? (
                <Button variant="ghost" size="xs" disabled={pending} onClick={() => {
                  if (!confirm(provider.id === "gmail" ? "Disconnect Gmail? Every email Tidemark synced from this mailbox will be deleted." : `Disconnect ${provider.name}?`)) return;
                  start(async () => { const r = await disconnectIntegration(c.id); if (r.error) toast.error(r.error); else { toast.success("Disconnected"); router.refresh(); } });
                }}>Disconnect</Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-auto pt-4">
        {!provider.configured ? (
          <p className="text-xs text-muted-foreground">Not configured: set the {provider.name} OAuth client ID/secret in the server environment.</p>
        ) : provider.adminOnly && !canAdmin ? (
          <p className="text-xs text-muted-foreground">Ask a workspace admin to connect {provider.name}.</p>
        ) : canConnect ? (
          provider.kind === "oauth" ? (
            <Button render={<a href={`/api/oauth/${provider.id}/start`} />}><Plug /> Connect {provider.name}</Button>
          ) : (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); connectKey(); }}>
              <Input type="password" placeholder={`${provider.name} API key`} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
              <Button type="submit" disabled={pending || !key.trim()}>{pending ? <Loader2 className="animate-spin" /> : null}Connect</Button>
            </form>
          )
        ) : null}
      </div>
    </div>
  );
}

function GmailControls({ conn }: { conn: ConnectionView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const hasSend = conn.scopes.some((s) => s.endsWith("gmail.send"));
  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <label className="flex items-center justify-between gap-3 text-xs">
        <span><span className="font-medium text-foreground">Send campaign emails from this mailbox</span><span className="block text-muted-foreground">Weekdays, inside sending hours, max 40/day.</span></span>
        <Switch
          checked={Boolean(conn.settings.sending_enabled)}
          disabled={pending}
          onCheckedChange={(v) => start(async () => {
            // Full navigation to the OAuth route handler (it redirects to Google), not a page.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            if (v && !hasSend) { window.location.href = "/api/oauth/gmail/start?sending=1"; return; }
            const r = await updateGmailSettings(conn.id, { sending_enabled: v });
            if (r.error) toast.error(r.error); else router.refresh();
          })}
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">Read threads with</span>
        <select
          className="h-7 rounded-md border bg-background px-2"
          value={conn.settings.prospect_scope ?? "qualified"}
          disabled={pending}
          onChange={(e) => start(async () => { await updateGmailSettings(conn.id, { prospect_scope: e.target.value as "qualified" | "owned" }); router.refresh(); })}
        >
          <option value="qualified">All workspace prospects</option>
          <option value="owned">Only prospects I own</option>
        </select>
      </label>
    </div>
  );
}
