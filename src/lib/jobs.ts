import { createAdminClient } from "@/lib/supabase/admin";

// Job kinds and their payloads. The worker's handler table
// (src/lib/worker/handlers.ts) must cover every kind listed here.
export interface JobPayloads {
  "ingest.source": { connector: string; since?: string; limit?: number };
  "records.resolve": { limit?: number };
  "company.enrich": { companyId: string };
  "workspace.match": { workspaceId: string; icpId?: string };
  "account.research": { accountId: string; force?: boolean };
  "account.contacts": { accountId: string };
  "account.warm_paths": { accountId: string };
  "workspace.warm_paths": { workspaceId: string };
  "kb.process": { documentId: string };
  "kb.crawl": { workspaceId: string; url: string; documentId: string };
  "seller.profile": { workspaceId: string };
  "icp.suggest": { workspaceId: string };
  "crm.push": { connectionId: string; accountIds?: string[] };
  "crm.pull": { connectionId: string };
  "gmail.sync": { connectionId: string };
  "granola.sync": { connectionId: string };
  "campaign.draft": { enrollmentId: string };
  "campaign.send_due": Record<string, never>;
  "instantly.push": { campaignId: string; enrollmentIds: string[] };
  "insights.generate": { workspaceId: string };
  "demo.seed": { workspaceId: string };
}

export type JobKind = keyof JobPayloads;

export interface EnqueueOptions {
  workspaceId?: string | null;
  dedupeKey?: string;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
}

export async function enqueue<K extends JobKind>(kind: K, payload: JobPayloads[K], opts: EnqueueOptions = {}) {
  const { data, error } = await createAdminClient().rpc("enqueue_job", {
    p_kind: kind,
    p_payload: payload,
    p_workspace_id: opts.workspaceId ?? null,
    p_dedupe_key: opts.dedupeKey ?? null,
    p_run_after: (opts.runAfter ?? new Date()).toISOString(),
    p_priority: opts.priority ?? 100,
    p_max_attempts: opts.maxAttempts ?? 3,
  });
  if (error) throw new Error(`enqueue ${kind} failed: ${error.message}`);
  return data as number | null; // null = deduped
}

/** Insert-once ledger for periodic schedules. Returns true the first time a key is seen. */
export async function claimSchedule(key: string): Promise<boolean> {
  const { error } = await createAdminClient().from("scheduled_runs").insert({ key });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`scheduled_runs insert failed: ${error.message}`);
}

/** Thrown by a handler to put its job back for later without spending an attempt. */
export class DeferJobError extends Error {
  constructor(message: string, readonly delayMs: number) {
    super(message);
    this.name = "DeferJobError";
  }
}
