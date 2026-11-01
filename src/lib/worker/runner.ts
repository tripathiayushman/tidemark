import { hostname } from "node:os";
import { createAdminClient } from "@/lib/supabase/admin";
import { claimSchedule, enqueue, type JobKind } from "@/lib/jobs";
import { CONNECTORS } from "@/lib/sources";
import { coreHandlers, type HandlerTable } from "./handlers";
import { integrationHandlers } from "@/lib/integrations/handlers";
import { LlmRateLimitError } from "@/lib/ai/llm";

// Drains the job queue for up to `budgetMs`, then returns. Called by the cron
// endpoint (POST /api/worker/tick) and by `npm run worker` in a loop.

const handlers: HandlerTable = { ...coreHandlers, ...integrationHandlers };

export interface TickResult {
  scheduled: string[];
  ran: { id: number; kind: string; ok: boolean; ms: number; error?: string }[];
}

export async function tick(opts: { budgetMs?: number; worker?: string } = {}): Promise<TickResult> {
  const db = createAdminClient();
  const deadline = Date.now() + (opts.budgetMs ?? 50_000);
  const worker = opts.worker ?? `${hostname()}:${process.pid}`;
  const scheduled = await planPeriodicJobs();
  const ran: TickResult["ran"] = [];

  let rateLimited = false;
  while (Date.now() < deadline - 5_000 && !rateLimited) {
    const { data: jobs, error } = await db.rpc("claim_jobs", { p_worker: worker, p_limit: 3, p_kinds: null });
    if (error) throw new Error(`claim_jobs: ${error.message}`);
    if (!jobs?.length) break;
    await Promise.all(
      (jobs as { id: number; kind: JobKind; payload: unknown; attempts: number }[]).map(async (job) => {
        const started = Date.now();
        const handler = handlers[job.kind] as ((db: unknown, p: unknown) => Promise<unknown>) | undefined;
        try {
          if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
          const result = await handler(db, job.payload);
          await db.rpc("complete_job", { p_id: job.id, p_result: (result ?? null) as object });
          ran.push({ id: job.id, kind: job.kind, ok: true, ms: Date.now() - started });
        } catch (e) {
          if (e instanceof LlmRateLimitError) {
            // Free-tier limit: put the job back for when the limit resets, without
            // spending one of its attempts, and stop claiming work this tick.
            rateLimited = true;
            await db.from("jobs").update({
              status: "queued",
              attempts: Math.max(0, job.attempts - 1),
              run_after: new Date(Date.now() + e.retryAfterMs).toISOString(),
              locked_at: null,
              locked_by: null,
              last_error: e.message.slice(0, 500),
            }).eq("id", job.id);
            ran.push({ id: job.id, kind: job.kind, ok: false, ms: Date.now() - started, error: `deferred ${Math.round(e.retryAfterMs / 1000)}s: rate limit` });
            return;
          }
          const msg = (e as Error).message ?? String(e);
          console.error(`[worker] job ${job.id} ${job.kind} failed: ${msg}`);
          await db.rpc("fail_job", { p_id: job.id, p_error: msg });
          ran.push({ id: job.id, kind: job.kind, ok: false, ms: Date.now() - started, error: msg });
        }
      }),
    );
  }
  return { scheduled, ran };
}

/**
 * Periodic work, keyed by time bucket so each runs once per bucket no matter
 * how many workers tick:
 *   connectors      daily / weekly, staggered
 *   re-research     every 30 min for accounts with new signals
 *   integrations    CRM sync 15 min, Gmail 10 min, Granola hourly
 *   campaign send   every 5 min (sender enforces caps + windows)
 *   insights        daily per workspace
 */
export async function planPeriodicJobs(now = new Date()): Promise<string[]> {
  const db = createAdminClient();
  const out: string[] = [];
  const day = now.toISOString().slice(0, 10);
  const isoWeek = `${now.getUTCFullYear()}-w${Math.ceil(((+now - +new Date(Date.UTC(now.getUTCFullYear(), 0, 1))) / 86_400_000 + 1) / 7)}`;
  const bucket = (mins: number) => `${day}T${Math.floor((now.getUTCHours() * 60 + now.getUTCMinutes()) / mins)}`;

  for (const c of CONNECTORS) {
    if (c.schedule === "manual" || c.disabledReason()) continue;
    const key = `ingest:${c.id}:${c.schedule === "daily" ? day : isoWeek}`;
    if (await claimSchedule(key)) {
      await enqueue("ingest.source", { connector: c.id }, { dedupeKey: `ingest:${c.id}`, priority: 120 });
      out.push(key);
    }
  }
  if (await claimSchedule(`ingest:fmcsa.fleet_refresh:${isoWeek}`)) {
    await enqueue("ingest.source", { connector: "fmcsa.fleet_refresh" }, { dedupeKey: "ingest:fmcsa.fleet_refresh", priority: 130 });
    out.push("fleet_refresh");
  }

  if (await claimSchedule(`reresearch:${bucket(30)}`)) {
    const { data } = await db.rpc("accounts_needing_research", { p_limit: 200 });
    for (const a of (data ?? []) as { account_id: string; workspace_id: string }[]) {
      await enqueue("account.research", { accountId: a.account_id }, { workspaceId: a.workspace_id, dedupeKey: `research:${a.account_id}`, priority: 90 });
    }
    out.push(`reresearch(${data?.length ?? 0})`);
  }

  const { data: conns } = await db.from("integration_connections").select("id, workspace_id, provider").eq("status", "active");
  for (const c of conns ?? []) {
    const plan: Record<string, [JobKind, number] | undefined> = {
      hubspot: ["crm.pull", 15], attio: ["crm.pull", 15], gmail: ["gmail.sync", 10], granola: ["granola.sync", 60],
    };
    const p = plan[c.provider as string];
    if (!p) continue;
    const key = `${p[0]}:${c.id}:${bucket(p[1])}`;
    if (await claimSchedule(key)) {
      await enqueue(p[0], { connectionId: c.id } as never, { workspaceId: c.workspace_id, dedupeKey: `${p[0]}:${c.id}`, priority: 70 });
      out.push(key);
    }
  }

  if (await claimSchedule(`campaign.send_due:${bucket(5)}`)) {
    await enqueue("campaign.send_due", {}, { dedupeKey: "campaign.send_due", priority: 40 });
  }

  const { data: workspaces } = await db.from("workspaces").select("id").eq("onboarding_step", "done");
  for (const w of workspaces ?? []) {
    if (await claimSchedule(`insights:${w.id}:${day}`)) {
      await enqueue("insights.generate", { workspaceId: w.id }, { workspaceId: w.id, dedupeKey: `insights:${w.id}`, priority: 150 });
    }
    if (await claimSchedule(`match:${w.id}:${day}`)) {
      await enqueue("workspace.match", { workspaceId: w.id }, { workspaceId: w.id, dedupeKey: `match:${w.id}`, priority: 110 });
    }
  }
  return out;
}
