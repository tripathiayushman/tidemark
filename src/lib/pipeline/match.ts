import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueue } from "@/lib/jobs";
import type { Icp } from "@/lib/types";
import { isoDaysAgo } from "./normalize";

// Puts companies from the shared graph onto a workspace's watchlist: anything
// with recent signals that passes the ICP's coarse filters becomes an account
// (research_status=queued) and gets a research job.

export async function matchWorkspace(db: SupabaseClient, workspaceId: string, icpId?: string, limit = 500) {
  const query = db.from("icps").select("*").eq("workspace_id", workspaceId).eq("is_active", true);
  const { data: icps, error } = icpId ? await query.eq("id", icpId) : await query;
  if (error) throw new Error(`load icps: ${error.message}`);
  let added = 0;
  let queued = 0;

  for (const icp of (icps ?? []) as Icp[]) {
    const since = isoDaysAgo(icp.signal_preferences?.lookback_days ?? 540);
    const { data: cands, error: cErr } = await db.rpc("candidate_companies", {
      p_since: since,
      p_naics_prefixes: (icp.criteria.industries ?? []).map((i) => i.naics_prefix),
      p_states: (icp.criteria.states ?? []).map((s) => s.toUpperCase()),
      p_exclude_states: (icp.criteria.exclude_states ?? []).map((s) => s.toUpperCase()),
      p_limit: limit,
    });
    if (cErr) throw new Error(`candidate_companies: ${cErr.message}`);
    const ids = ((cands ?? []) as { company_id: string }[]).map((c) => c.company_id);
    if (!ids.length) continue;

    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data: inserted, error: iErr } = await db
        .from("accounts")
        .upsert(
          chunk.map((company_id) => ({ workspace_id: workspaceId, company_id, icp_id: icp.id, research_status: "queued" })),
          { onConflict: "workspace_id,company_id", ignoreDuplicates: true },
        )
        .select("id");
      if (iErr) throw new Error(`insert accounts: ${iErr.message}`);
      added += inserted?.length ?? 0;
      for (const a of inserted ?? []) {
        await enqueue("account.research", { accountId: a.id }, { workspaceId, dedupeKey: `research:${a.id}`, priority: 80 });
        queued++;
      }
    }
  }
  return { added, queued };
}
