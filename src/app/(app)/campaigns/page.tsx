import type { Metadata } from "next";
import Link from "next/link";
import { Megaphone } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/tm/page-header";
import { NewCampaignButton, AddToCampaignDialog } from "./client";
import { ago } from "@/lib/format";

export const metadata: Metadata = { title: "Campaigns" };

export default async function CampaignsPage(props: PageProps<"/campaigns">) {
  const ctx = await requireWorkspace();
  const sp = await props.searchParams;
  const supabase = await createClient();
  const [{ data: campaigns }, { data: conns }, { data: enrollments }] = await Promise.all([
    supabase.from("campaigns").select("id, name, channel, status, launched_at, created_at").eq("workspace_id", ctx.workspace.id).neq("status", "archived").order("created_at", { ascending: false }),
    supabase.from("integration_connections").select("id, provider, account_label, connected_by, settings").eq("workspace_id", ctx.workspace.id).in("provider", ["gmail", "instantly"]).eq("status", "active"),
    supabase.from("campaign_enrollments").select("campaign_id, status").eq("workspace_id", ctx.workspace.id).limit(20000),
  ]);
  const stats = new Map<string, { enrolled: number; active: number; replied: number; bounced: number; unsub: number }>();
  for (const e of enrollments ?? []) {
    const s = stats.get(e.campaign_id as string) ?? { enrolled: 0, active: 0, replied: 0, bounced: 0, unsub: 0 };
    s.enrolled++;
    if (e.status === "active") s.active++;
    if (e.status === "stopped_reply") s.replied++;
    if (e.status === "stopped_bounce") s.bounced++;
    if (e.status === "stopped_unsubscribe") s.unsub++;
    stats.set(e.campaign_id as string, s);
  }
  const mailboxes = (conns ?? []).filter((c) => c.provider === "gmail" && c.connected_by === ctx.user.id).map((c) => ({ id: c.id as string, label: (c.account_label as string) ?? "Gmail" }));
  const instantly = (conns ?? []).find((c) => c.provider === "instantly");
  const addAccount = typeof sp.add === "string" ? sp.add : null;

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Low-volume, relevant outreach. Gmail sends weekdays only, inside your hours, max 40/day per mailbox. Instantly campaigns send from Instantly."
        actions={<NewCampaignButton mailboxes={mailboxes} instantlyConnectionId={(instantly?.id as string) ?? null} />}
      />
      {addAccount ? <AddToCampaignDialog accountId={addAccount} campaigns={(campaigns ?? []).map((c) => ({ id: c.id as string, name: c.name as string, channel: c.channel as string }))} /> : null}
      <div className="p-6">
        {!campaigns?.length ? (
          <EmptyState icon={<Megaphone className="size-6" />} title="No campaigns yet">
            {mailboxes.length || instantly ? "Create a campaign, then add prospects from their profile." : "Connect Gmail or Instantly in Settings → Integrations to start a campaign."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Campaign</th><th className="px-4 py-2.5 font-medium">Channel</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 text-right font-medium">Enrolled</th><th className="px-4 py-2.5 text-right font-medium">In sequence</th><th className="px-4 py-2.5 text-right font-medium">Replied</th><th className="px-4 py-2.5 text-right font-medium">Bounced</th><th className="px-4 py-2.5 text-right font-medium">Unsubscribed</th></tr>
              </thead>
              <tbody className="divide-y">
                {campaigns.map((c) => {
                  const s = stats.get(c.id as string) ?? { enrolled: 0, active: 0, replied: 0, bounced: 0, unsub: 0 };
                  return (
                    <tr key={c.id as string} className="hover:bg-muted/40">
                      <td className="px-4 py-2.5"><Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">{c.name as string}</Link><div className="text-xs text-muted-foreground">{c.launched_at ? `launched ${ago(c.launched_at as string)}` : "not launched"}</div></td>
                      <td className="px-4 py-2.5 capitalize">{c.channel as string}</td>
                      <td className="px-4 py-2.5 capitalize">{c.status as string}</td>
                      {[s.enrolled, s.active, s.replied, s.bounced, s.unsub].map((n, i) => <td key={i} className="px-4 py-2.5 text-right tabular-nums">{n}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
