import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueue, type JobKind, type JobPayloads } from "@/lib/jobs";
import { refreshFleets, runConnector } from "@/lib/pipeline/ingest";
import { resolvePendingRecords } from "@/lib/pipeline/resolve";
import { matchWorkspace } from "@/lib/pipeline/match";
import { researchAccount } from "@/lib/pipeline/research";
import { findContactsForAccount } from "@/lib/pipeline/contacts";
import { computeWarmPaths } from "@/lib/pipeline/warm-paths";
import { buildSellerProfile, processDocument } from "@/lib/knowledge/process";
import { generateInsights } from "@/lib/pipeline/insights";
import { loadDemoData } from "@/lib/seed/load";

// Job kind → handler. Integrations register theirs in
// src/lib/integrations/handlers.ts so this file stays dependency-light.

type Handler<K extends JobKind> = (db: SupabaseClient, payload: JobPayloads[K]) => Promise<unknown>;
export type HandlerTable = { [K in JobKind]?: Handler<K> };

export const coreHandlers: HandlerTable = {
  "ingest.source": (db, p) =>
    p.connector === "fmcsa.fleet_refresh" ? refreshFleets(db) : runConnector(db, p.connector, { since: p.since, limit: p.limit }),
  "records.resolve": async (db, p) => {
    const r = await resolvePendingRecords(db, { limit: p.limit ?? 500, budgetMs: 35_000 });
    // keep draining in follow-up jobs until nothing is left (or a pass makes no progress)
    if (r.remaining > 0 && r.processed > r.failed) {
      await enqueue("records.resolve", { limit: p.limit ?? 500 }, { dedupeKey: "records.resolve:next", priority: 60, runAfter: new Date(Date.now() + 2_000) });
    }
    return r;
  },
  "workspace.match": (db, p) => matchWorkspace(db, p.workspaceId, p.icpId),
  "account.research": (db, p) => researchAccount(db, p.accountId, { force: p.force }),
  "account.contacts": (db, p) => findContactsForAccount(db, p.accountId),
  "account.warm_paths": (db, p) => computeWarmPaths(db, p.accountId),
  "workspace.warm_paths": async (db, p) => {
    const { data } = await db.from("accounts").select("id").eq("workspace_id", p.workspaceId).eq("research_status", "qualified");
    let paths = 0;
    for (const a of data ?? []) paths += (await computeWarmPaths(db, a.id)).paths;
    return { accounts: data?.length ?? 0, paths };
  },
  "kb.process": (db, p) => processDocument(db, p.documentId),
  "kb.crawl": (db, p) => processDocument(db, p.documentId),
  "seller.profile": (db, p) => buildSellerProfile(db, p.workspaceId),
  "insights.generate": (db, p) => generateInsights(db, p.workspaceId),
  "demo.seed": (db, p) => loadDemoData(db, p.workspaceId),
};
