import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Section } from "@/components/tm/page-header";
import { ago, shortDate } from "@/lib/format";
import { CampaignControls, CampaignSettings, StepsEditor, DraftEditor, StopButton, BulkEnroll } from "./client";

export const metadata: Metadata = { title: "Campaign" };

const ENROLL_LABEL: Record<string, string> = {
  active: "In sequence", completed: "Completed", stopped_reply: "Replied", stopped_bounce: "Bounced",
  stopped_unsubscribe: "Unsubscribed", stopped_manual: "Stopped", failed: "Not sent",
};

export default async function CampaignPage(props: PageProps<"/campaigns/[id]">) {
  const ctx = await requireWorkspace();
  const { id } = await props.params;
  const supabase = await createClient();
  const { data: c } = await supabase.from("campaigns").select("*").eq("id", id).eq("workspace_id", ctx.workspace.id).maybeSingle();
  if (!c) notFound();
  const [{ data: steps }, { data: enrollments }, { data: drafts }, { data: mailbox }, { data: qualified }] = await Promise.all([
    supabase.from("campaign_steps").select("position, delay_days, subject_template, body_template, ai_draft").eq("campaign_id", id).order("position"),
    supabase.from("campaign_enrollments").select("id, status, current_step, next_send_at, stop_reason, external_lead_id, account_id, contacts(full_name, title, email), accounts(companies(name))").eq("campaign_id", id).order("created_at", { ascending: false }).limit(500),
    supabase.from("campaign_messages").select("id, step_position, subject, body, status, enrollment_id, campaign_enrollments!inner(campaign_id, contacts(full_name))").eq("campaign_enrollments.campaign_id", id).in("status", ["draft", "scheduled"]).order("created_at").limit(50),
    c.mailbox_connection_id ? supabase.from("integration_connections").select("account_label, settings, scopes").eq("id", c.mailbox_connection_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("prospect_rows").select("id, company_name, tier").eq("workspace_id", ctx.workspace.id).eq("research_status", "qualified").order("score", { ascending: false }).limit(200),
  ]);
  const sendingOn = Boolean((mailbox?.settings as { sending_enabled?: boolean } | null)?.sending_enabled);
  const enrolledAccounts = new Set((enrollments ?? []).map((e) => e.account_id as string));

  return (
    <div>
      <div className="border-b px-6 py-5">
        <Link href="/campaigns" className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3" /> Campaigns</Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{c.name}</h1>
            <p className="text-sm text-muted-foreground">
              {c.channel === "gmail" ? `Gmail · ${mailbox?.account_label ?? "mailbox removed"}` : "Instantly"} · <span className="capitalize">{c.status}</span>
              {c.launched_at ? ` · launched ${ago(c.launched_at)}` : ""}
            </p>
            {c.channel === "gmail" && !sendingOn ? <p className="mt-1 text-xs text-signal-foreground">Sending is off for this mailbox — switch it on in Settings → Integrations. Nothing sends until you do.</p> : null}
          </div>
          <CampaignControls id={id} status={c.status} />
        </div>
      </div>
      <div className="grid gap-8 p-6 lg:grid-cols-3">
        <div className="space-y-8 lg:col-span-2">
          {c.channel === "gmail" ? (
            <Section title="Sequence">
              <StepsEditor campaignId={id} initial={(steps ?? []) as { position: number; delay_days: number; subject_template: string; body_template: string; ai_draft: boolean }[]} />
            </Section>
          ) : (
            <Section title="Template">
              <p className="text-sm text-muted-foreground">The Instantly campaign sends the emails. Put <code className="rounded bg-muted px-1">{"{{tidemark_subject}}"}</code> and <code className="rounded bg-muted px-1">{"{{tidemark_body}}"}</code> in its first step; Tidemark fills them with a first email drafted from each prospect&apos;s records.</p>
            </Section>
          )}

          {drafts?.length ? (
            <Section title={`Drafts to review (${drafts.length})`}>
              <div className="space-y-3">
                {drafts.map((d) => (
                  <DraftEditor key={d.id} id={d.id} to={((d.campaign_enrollments as unknown as { contacts: { full_name: string } | null }).contacts?.full_name) ?? "Contact"} step={d.step_position} subject={d.subject ?? ""} body={d.body} />
                ))}
              </div>
            </Section>
          ) : null}

          <Section title={`Enrolled (${enrollments?.length ?? 0})`} action={<BulkEnroll campaignId={id} prospects={(qualified ?? []).filter((p) => !enrolledAccounts.has(p.id as string)).map((p) => ({ id: p.id as string, name: p.company_name as string, tier: p.tier as string }))} />}>
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr><th className="px-4 py-2.5 font-medium">Contact</th><th className="px-4 py-2.5 font-medium">Company</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">{c.channel === "gmail" ? "Next email" : "In Instantly"}</th><th /></tr>
                </thead>
                <tbody className="divide-y">
                  {(enrollments ?? []).map((e) => {
                    const contact = e.contacts as unknown as { full_name: string; title: string | null; email: string } | null;
                    return (
                      <tr key={e.id}>
                        <td className="px-4 py-2.5"><div className="font-medium">{contact?.full_name}</div><div className="text-xs text-muted-foreground">{contact?.title}</div></td>
                        <td className="px-4 py-2.5"><Link className="hover:underline" href={`/prospects/${e.account_id}`}>{(e.accounts as unknown as { companies: { name: string } } | null)?.companies?.name}</Link></td>
                        <td className="px-4 py-2.5">{ENROLL_LABEL[e.status as string] ?? e.status}{e.stop_reason && e.status === "failed" ? <div className="text-xs text-muted-foreground">{e.stop_reason}</div> : null}</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {c.channel === "gmail" ? (e.status === "active" ? `Step ${Number(e.current_step) + 1}${e.next_send_at ? ` · ${shortDate(e.next_send_at as string)}` : " · after launch"}` : "—") : e.external_lead_id ? "Added" : "Pending"}
                        </td>
                        <td className="px-4 py-2.5 text-right">{e.status === "active" ? <StopButton id={e.id} /> : null}</td>
                      </tr>
                    );
                  })}
                  {!enrollments?.length ? <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">No one enrolled yet. Add prospects here or from a buyer profile.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
        <div>
          {c.channel === "gmail" ? (
            <Section title="Sending rules">
              <CampaignSettings id={id} days={c.sending_days as number[]} start={(c.send_window_start as string).slice(0, 5)} end={(c.send_window_end as string).slice(0, 5)} timezone={c.timezone as string} cap={c.daily_cap as number} />
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
