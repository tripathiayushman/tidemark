import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Link2, Mail, MapPin, Phone, Users } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CategoryChip, DemoTag, ResearchStatusText, TierBadge, VerifiedDot } from "@/components/tm/badges";
import { Section } from "@/components/tm/page-header";
import { AutoRefresh } from "@/components/tm/auto-refresh";
import { ago, daysLeft, money, shortDate, windowLabel } from "@/lib/format";
import { READINESS_LABEL, ROLE_TAG_LABEL, type Account, type Company, type Contact, type Readiness, type RoleTag, type ScoreLine, type Signal } from "@/lib/types";
import { ProfileActions, NoteForm, ContactActions } from "./client";
import { cn } from "@/lib/utils";

export async function generateMetadata(props: PageProps<"/prospects/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const supabase = await createClient();
  const { data } = await supabase.from("prospect_rows").select("company_name").eq("id", id).maybeSingle();
  return { title: data?.company_name ?? "Prospect" };
}

export default async function ProfilePage(props: PageProps<"/prospects/[id]">) {
  const ctx = await requireWorkspace();
  const { id } = await props.params;
  const supabase = await createClient();

  const { data: account } = await supabase.from("accounts").select("*, icps(name)").eq("id", id).eq("workspace_id", ctx.workspace.id).maybeSingle();
  if (!account) notFound();
  const acc = account as Account & { icps: { name: string } | null; target_roles: string[] };

  const [company, evidence, signals, contacts, warm, activities, emails, meetings, tasks, lists, members, crm] = await Promise.all([
    supabase.from("companies").select("*").eq("id", acc.company_id).single(),
    supabase.from("account_evidence").select("note, position, signals(*)").eq("account_id", id).order("position"),
    supabase.from("signals").select("*").eq("company_id", acc.company_id).order("occurred_on", { ascending: false }).limit(50),
    supabase.from("contacts").select("*").eq("account_id", id).order("role_tag"),
    supabase.from("warm_paths").select("id, explanation, strength, path_type, member_id").eq("account_id", id).order("strength", { ascending: false }),
    supabase.from("activities").select("id, kind, title, body, occurred_at, actor_id").eq("account_id", id).order("occurred_at", { ascending: false }).limit(30),
    supabase.from("email_messages").select("id, subject, snippet, direction, from_email, sent_at").eq("account_id", id).order("sent_at", { ascending: false }).limit(20),
    supabase.from("meetings").select("id, title, started_at, ai_notes").eq("account_id", id).order("started_at", { ascending: false }).limit(10),
    supabase.from("tasks").select("id, title, due_on, status").eq("account_id", id).eq("status", "open").order("due_on"),
    supabase.from("list_members").select("lists(name)").eq("account_id", id),
    supabase.from("workspace_members").select("user_id, profiles(full_name, email)").eq("workspace_id", ctx.workspace.id),
    supabase.from("crm_links").select("object_type, remote_id, last_pushed_at, integration_connections(provider)").eq("local_id", id),
  ]);
  const c = company.data as Company;
  const ev = (evidence.data ?? []) as unknown as { note: string; position: number; signals: Signal }[];
  const allSignals = (signals.data ?? []) as Signal[];
  const people = (contacts.data ?? []) as Contact[];
  const roleOrder: RoleTag[] = ["decision_maker", "runs_the_build", "champion", "influencer", "other"];
  people.sort((a, b) => roleOrder.indexOf(a.role_tag) - roleOrder.indexOf(b.role_tag));
  const memberList = (members.data ?? []).map((m) => ({ id: m.user_id as string, name: ((m.profiles as unknown as { full_name: string | null; email: string | null } | null)?.full_name ?? (m.profiles as unknown as { email: string | null } | null)?.email ?? "Member") as string }));
  const busy = ["queued", "researching", "checking"].includes(acc.research_status);
  const left = daysLeft(acc.contact_window_end);
  const qualified = acc.research_status === "qualified";

  const timeline = [
    ...(activities.data ?? []).map((a) => ({ id: `a${a.id}`, at: a.occurred_at as string, title: a.title as string, body: a.body as string | null, kind: a.kind as string })),
    ...(emails.data ?? []).map((e) => ({ id: `e${e.id}`, at: e.sent_at as string, title: `${e.direction === "inbound" ? "Email from" : "Email to"} · ${e.subject ?? "(no subject)"}`, body: e.snippet as string | null, kind: "email" })),
    ...(meetings.data ?? []).map((m) => ({ id: `m${m.id}`, at: m.started_at as string, title: `Meeting · ${m.title ?? "Untitled"}`, body: (m.ai_notes as string | null)?.slice(0, 280) ?? null, kind: "meeting" })),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  return (
    <div>
      <AutoRefresh active={busy} />
      <div className="border-b px-6 py-5">
        <Link href="/prospects" className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3" /> Prospects</Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <TierBadge tier={acc.tier} className="size-8 text-sm" />
              <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
              {c.is_synthetic ? <DemoTag /> : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {c.city || c.state ? <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" />{[c.city, c.state].filter(Boolean).join(", ")}</span> : null}
              {c.industry || c.naics_title ? <span>{c.industry ?? c.naics_title}{c.naics_code ? ` · NAICS ${c.naics_code}` : ""}</span> : null}
              {c.employee_count ? <span className="inline-flex items-center gap-1"><Users className="size-3.5" />~{c.employee_count.toLocaleString()}</span> : null}
              {c.domain && !c.is_synthetic ? <a href={`https://${c.domain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">{c.domain}<ExternalLink className="size-3" /></a> : null}
              {acc.icps?.name ? <span>Segment: {acc.icps.name}</span> : null}
            </div>
          </div>
          <ProfileActions accountId={id} status={acc.status} ownerId={acc.owner_id} members={memberList} lists={((lists.data ?? []) as unknown as { lists: { name: string } }[]).map((l) => l.lists.name)} />
        </div>
      </div>

      <div className="grid gap-8 p-6 lg:grid-cols-3">
        <div className="space-y-8 lg:col-span-2">
          <div className={cn("rounded-xl border bg-card p-5", qualified && "border-tide/40")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason to buy</span>
              {busy ? <ResearchStatusText status={acc.research_status} /> : <span className="text-xs text-muted-foreground">Researched {ago(acc.last_researched_at)}</span>}
            </div>
            {qualified ? (
              <>
                <p className="mt-2 text-xl font-semibold leading-snug">{acc.reason_to_buy}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {acc.timing_label ? <span className="rounded-full bg-accent px-2 py-0.5 font-medium text-accent-foreground">{acc.timing_label}</span> : null}
                  {acc.readiness ? <span className={cn("rounded-full px-2 py-0.5 font-medium", acc.readiness === "ready_now" ? "bg-signal/25 text-signal-foreground" : "bg-muted text-muted-foreground")}>{READINESS_LABEL[acc.readiness as Readiness]}</span> : null}
                  {acc.confidence ? <span className="text-muted-foreground">Confidence: {acc.confidence}</span> : null}
                </div>
                {acc.why ? <p className="mt-4 text-sm leading-relaxed"><span className="font-medium">Why: </span>{acc.why}</p> : null}
                {acc.next_step ? <p className="mt-2 text-sm text-muted-foreground"><span className="font-medium text-foreground">Next step: </span>{acc.next_step}</p> : null}
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {busy ? "Reading this company's records…" : acc.research_status === "disqualified" ? "Outside your ICP." : "No reason to buy yet — Tidemark keeps watching and re-checks when new records arrive."}
              </p>
            )}
          </div>

          {acc.reasoning ? (
            <Section title="Reading the timeline">
              <p className="whitespace-pre-line text-sm leading-relaxed">{acc.reasoning}</p>
            </Section>
          ) : null}

          {ev.length ? (
            <Section title="Records behind it">
              <ol className="relative space-y-4 border-l pl-5">
                {ev.map((e) => (
                  <li key={e.signals.id} className="relative">
                    <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full border-2 border-background bg-tide" />
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="tabular-nums">{shortDate(e.signals.occurred_on)}</span>
                      <CategoryChip category={e.signals.category} />
                      <span className="capitalize">{e.signals.source === "seed" ? "demo record" : e.signals.source}</span>
                    </div>
                    <p className="mt-1 font-medium">{e.signals.title}</p>
                    {e.signals.detail ? <p className="text-sm text-muted-foreground">{e.signals.detail}</p> : null}
                    <p className="mt-1 text-sm"><span className="text-muted-foreground">Why it counts: </span>{e.note}</p>
                    {e.signals.source_url && !e.signals.is_synthetic ? <a href={e.signals.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-tide hover:underline">Source record <ExternalLink className="size-3" /></a> : null}
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          <Section title={`All records (${allSignals.length})`}>
            {allSignals.length ? (
              <ul className="divide-y rounded-xl border bg-card text-sm">
                {allSignals.map((s) => (
                  <li key={s.id} className="flex items-start gap-3 px-4 py-2.5">
                    <span className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground">{shortDate(s.occurred_on)}</span>
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{s.title}</span>
                      {s.detail ? <span className="text-muted-foreground"> — {s.detail}</span> : null}
                    </div>
                    {s.amount ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{money(s.amount)}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No records yet.</p>}
          </Section>

          <Section title="Activity">
            <NoteForm accountId={id} />
            <ul className="mt-4 space-y-3">
              {timeline.map((t) => (
                <li key={t.id} className="text-sm">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">{t.title}</span><span className="shrink-0 text-xs text-muted-foreground">{ago(t.at)}</span></div>
                  {t.body ? <p className="mt-0.5 whitespace-pre-line text-muted-foreground">{t.body}</p> : null}
                </li>
              ))}
              {!timeline.length ? <li className="text-sm text-muted-foreground">No activity yet.</li> : null}
            </ul>
          </Section>
        </div>

        <div className="space-y-8">
          {qualified ? (
            <div className="rounded-xl border bg-card p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contact window</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{windowLabel(acc.contact_window_start, acc.contact_window_end)}</div>
              {left != null ? <div className={cn("text-xs", left <= 7 ? "text-destructive" : "text-muted-foreground")}>{left > 0 ? `${left} days left to reach out` : "Window has passed"}</div> : null}
            </div>
          ) : null}

          <Section title="People to reach" action={<ContactActions accountId={id} />}>
            {people.length ? (
              <ul className="space-y-3">
                {people.map((p) => (
                  <li key={p.id} className="rounded-xl border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium">{p.full_name}</div>
                        <div className="text-xs text-muted-foreground">{p.title}</div>
                      </div>
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", p.role_tag === "decision_maker" ? "bg-primary text-primary-foreground" : p.role_tag === "runs_the_build" ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground")}>{ROLE_TAG_LABEL[p.role_tag]}</span>
                    </div>
                    <div className="mt-2 space-y-1 text-xs">
                      {p.email ? <div className="flex items-center gap-1.5"><Mail className="size-3 text-muted-foreground" /><a href={`mailto:${p.email}`} className="truncate hover:underline">{p.email}</a><VerifiedDot status={p.email_status} /></div> : null}
                      {p.phone ? <div className="flex items-center gap-1.5"><Phone className="size-3 text-muted-foreground" />{p.phone}</div> : null}
                      {p.linkedin_url ? <a href={p.linkedin_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:underline"><Link2 className="size-3 text-muted-foreground" />LinkedIn</a> : null}
                    </div>
                    {p.unsubscribed_at ? <div className="mt-1 text-xs text-destructive">Unsubscribed</div> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {acc.target_roles?.length ? `Looking for: ${acc.target_roles.slice(0, 3).join(", ")}.` : "No contacts yet."} Contacts come from your licensed provider (Settings → Data sources) or your CRM.
              </p>
            )}
          </Section>

          <Section title="Can introduce">
            {warm.data?.length ? (
              <ul className="space-y-2 text-sm">
                {warm.data.map((w) => <li key={w.id} className="rounded-lg bg-accent/50 px-3 py-2">{w.explanation}</li>)}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No warm paths yet. Connect Gmail or upload your LinkedIn connections in Settings → Network.</p>}
          </Section>

          {tasks.data?.length ? (
            <Section title="Open tasks">
              <ul className="space-y-1.5 text-sm">
                {tasks.data.map((t) => <li key={t.id} className="flex justify-between gap-2"><span>{t.title}</span><span className="text-xs text-muted-foreground">{t.due_on ? shortDate(t.due_on) : ""}</span></li>)}
              </ul>
            </Section>
          ) : null}

          <Section title="Score">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <div className="flex justify-between"><span>Overall</span><span className="font-semibold tabular-nums">{acc.score ?? "—"}/100</span></div>
              <ScoreBars title={`Fit ${acc.fit_score ?? "—"}`} lines={acc.fit_breakdown} />
              <ScoreBars title={`Activity ${acc.activity_score ?? "—"}`} lines={acc.activity_breakdown?.slice(0, 6) ?? null} activity />
            </div>
          </Section>

          {crm.data?.length ? (
            <Section title="In your CRM">
              <ul className="text-sm">
                {crm.data.map((l, i) => <li key={i} className="capitalize">{(l.integration_connections as unknown as { provider: string } | null)?.provider} · synced {ago(l.last_pushed_at as string | null)}</li>)}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ScoreBars({ title, lines, activity = false }: { title: string; lines: ScoreLine[] | null; activity?: boolean }) {
  if (!lines?.length) return null;
  const max = activity ? Math.max(1, ...lines.map((l) => Math.abs(l.score))) : 100;
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="space-y-2">
        {lines.map((l, i) => (
          <li key={i}>
            <div className="flex justify-between gap-2 text-xs"><span className="truncate">{l.criterion}</span><span className="tabular-nums text-muted-foreground">{l.score}</span></div>
            <div className="mt-1 h-1.5 rounded-full bg-muted"><div className={cn("h-1.5 rounded-full", l.score < 0 ? "bg-destructive" : "bg-tide")} style={{ width: `${Math.min(100, (Math.abs(l.score) / max) * 100)}%` }} /></div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{l.note}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
