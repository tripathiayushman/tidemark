import type { Metadata } from "next";
import { requireWorkspace, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { IntegrationCard, type ConnectionView } from "./card";
import { serverEnv } from "@/lib/env";
import { sandboxEnabled } from "@/lib/integrations/sandbox";

export const metadata: Metadata = { title: "Integrations" };

const PROVIDERS = [
  {
    id: "hubspot", name: "HubSpot", kind: "oauth" as const,
    blurb: "Pushes prospects, companies, lists and custom columns into HubSpot automatically. Brings back edits to a synced person's name, email, title, phone or LinkedIn URL.",
    rules: ["Never deletes a record in HubSpot", "Reads existing people to avoid duplicates", "People only in HubSpot stay out unless you ask chat to add them", "Disconnecting stops sync and leaves records in place"],
    configured: () => Boolean(serverEnv.hubspotClientId()),
  },
  {
    id: "attio", name: "Attio", kind: "oauth" as const,
    blurb: "Pushes prospects, lists and columns into Attio and brings back edits your team makes to synced people.",
    rules: ["Nothing deleted in Attio", "Two-way for people Tidemark synced", "Disconnecting stops sync and leaves records in place"],
    configured: () => Boolean(serverEnv.attioClientId()),
  },
  {
    id: "gmail", name: "Gmail", kind: "oauth" as const, perMember: true,
    blurb: "Threads with your prospects appear on their profile. Optionally send campaign emails from your mailbox.",
    rules: ["Read-only, limited to threads with your prospects", "Never used for ads or to train AI models", "Disconnecting deletes every synced email", "Sending is off until you switch it on: weekdays only, inside your sending hours, max 40/day per mailbox, unsubscribe link in every email, stops on reply/bounce/unsubscribe"],
    configured: () => Boolean(serverEnv.googleClientId()),
  },
  {
    id: "instantly", name: "Instantly", kind: "apikey" as const, adminOnly: true,
    blurb: "Adds prospects to the Instantly campaign you choose, each with a first email drafted from its signals. Replies, bounces and unsubscribes come back to Tidemark.",
    rules: ["Instantly sends from your mailboxes — Tidemark never does", "Only an admin can connect", "Disconnecting deletes Tidemark's copy of the API key"],
    configured: () => true,
  },
  {
    id: "granola", name: "Granola", kind: "apikey" as const, perMember: true,
    blurb: "Reads attendees, AI notes and transcripts — only for meetings where a prospect attended.",
    rules: ["Read-only; never changes anything in Granola", "Ignores meetings without a prospect"],
    configured: () => true,
  },
];

export default async function IntegrationsPage(props: PageProps<"/settings/integrations">) {
  const ctx = await requireWorkspace();
  const sp = await props.searchParams;
  const supabase = await createClient();
  const { data } = await supabase
    .from("integration_connections")
    .select("id, provider, status, account_label, last_synced_at, error, settings, scopes, connected_by")
    .eq("workspace_id", ctx.workspace.id)
    .order("created_at");
  const conns = (data ?? []) as ConnectionView[];

  return (
    <div className="space-y-4">
      {typeof sp.connected === "string" ? <p className="rounded-lg border border-tide/40 bg-accent/50 px-3 py-2 text-sm">Connected {sp.connected}. The first sync is running.</p> : null}
      {typeof sp.error === "string" ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{oauthError(sp.error)}</p> : null}
      {sandboxEnabled() ? (
        <p className="rounded-lg border border-dashed border-signal/60 bg-signal/10 px-3 py-2 text-sm">
          <span className="font-medium">Sandbox mode is on (dev only).</span> “Connect sandbox” creates a fake connection: CRM pushes, Gmail sends, replies and meetings are simulated inside Tidemark — nothing reaches a real service. Sandbox follow-up delays run in minutes instead of days.
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {PROVIDERS.map((p) => (
          <IntegrationCard
            key={p.id}
            provider={{ id: p.id, name: p.name, kind: p.kind, blurb: p.blurb, rules: p.rules, perMember: Boolean(p.perMember), adminOnly: Boolean(p.adminOnly), configured: p.configured() }}
            connections={conns.filter((c) => c.provider === p.id)}
            canAdmin={isAdmin(ctx.role)}
            userId={ctx.user.id}
            sandbox={sandboxEnabled()}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">OAuth apps are configured with environment variables (see README → Integrations). LinkedIn is not integrated: it offers no permitted API for reading profiles. Upload your own connections export under Network instead.</p>
    </div>
  );
}

const OAUTH_ERRORS: Record<string, string> = {
  not_configured: "This integration isn't configured on the server yet (missing OAuth client ID/secret).",
  invalid_state: "The connection request expired or was tampered with. Please try again.",
  session_mismatch: "You were signed in as a different user when the connection finished. Please try again.",
  access_denied: "Access was not granted.",
  oauth_error: "The provider returned an error. Please try again.",
  missing_code: "The provider didn't return an authorization code. Please try again.",
  read_scope_missing: "Read access to Gmail is required to sync prospect threads.",
  connect_failed: "Connecting failed. Please try again.",
};

function oauthError(code: string): string {
  const key = code.replace(/^(gmail|hubspot|attio)_/, "");
  return OAUTH_ERRORS[key] ?? code;
}
