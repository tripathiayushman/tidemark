// Health check for a Tidemark environment.
//   npm run doctor
// Checks env, database tables/RPCs, RLS, the storage bucket, the job queue
// round trip, and (if configured) one tiny LLM call. Writes nothing that
// persists except one job row it immediately completes.
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicEnv, serverEnv, optionalEnv } from "@/lib/env";

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => { console.log(`  ✗ ${m}`); process.exitCode = 1; };
const warn = (m: string) => console.log(`  ! ${m}`);

async function main() {
  console.log("Environment");
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "TIDEMARK_ENCRYPTION_KEY", "CRON_SECRET"]) {
    if (optionalEnv(k)) ok(k); else bad(`${k} missing`);
  }
  const provider = serverEnv.llmProvider();
  const llmKey = provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  if (optionalEnv(llmKey)) ok(`LLM: ${provider} (${provider === "openrouter" ? serverEnv.openrouterModel() : serverEnv.anthropicModel()})`);
  else warn(`${llmKey} not set — research, chat and drafting are disabled until it is`);

  console.log("\nDatabase");
  const db = createAdminClient();
  const tables = ["workspaces", "companies", "company_aliases", "source_records", "signals", "accounts", "account_evidence", "contacts", "icps", "kb_documents", "kb_chunks", "jobs", "campaigns", "integration_connections", "integration_secrets", "warm_paths", "chat_messages"];
  for (const t of tables) {
    const { error, count } = await db.from(t).select("*", { count: "exact", head: true });
    if (error) bad(`${t}: ${error.message}`); else ok(`${t} (${count ?? 0} rows)`);
  }
  const { error: viewErr } = await db.from("prospect_rows").select("id", { head: true, count: "exact" });
  if (viewErr) bad(`prospect_rows view: ${viewErr.message}`); else ok("prospect_rows view");
  const { data: cand, error: rpcErr } = await db.rpc("candidate_companies", { p_since: "2020-01-01", p_limit: 1 });
  if (rpcErr) bad(`candidate_companies: ${rpcErr.message}`); else ok(`candidate_companies RPC (${(cand as unknown[]).length} sample)`);

  console.log("\nSecurity");
  const anon = createClient(publicEnv.supabaseUrl(), publicEnv.supabasePublishableKey(), { auth: { persistSession: false } });
  const { data: leaked } = await anon.from("workspaces").select("id").limit(1);
  if ((leaked ?? []).length) bad("anonymous client can read workspaces — RLS broken"); else ok("anonymous client sees no workspaces (RLS on)");
  const { error: secErr, data: secRows } = await anon.from("integration_secrets").select("connection_id").limit(1);
  if ((secRows ?? []).length) bad("integration_secrets readable anonymously"); else ok(`integration_secrets not readable${secErr ? " (denied)" : ""}`);
  const { error: claimErr } = await anon.rpc("claim_jobs", { p_worker: "doctor-anon", p_limit: 1 });
  if (claimErr) ok("claim_jobs denied to non-service roles"); else bad("claim_jobs callable anonymously");

  console.log("\nStorage");
  const { data: bucket, error: bErr } = await db.storage.getBucket("knowledge");
  if (bErr || !bucket) bad(`knowledge bucket: ${bErr?.message}`); else ok(`knowledge bucket (private=${!bucket.public})`);

  console.log("\nJob queue");
  const key = `doctor:${Date.now()}`;
  const { data: jobId, error: eErr } = await db.rpc("enqueue_job", { p_kind: "doctor.ping", p_payload: {}, p_dedupe_key: key, p_priority: 0 });
  if (eErr) bad(`enqueue_job: ${eErr.message}`);
  else {
    const { data: claimed, error: cErr } = await db.rpc("claim_jobs", { p_worker: "doctor", p_limit: 5, p_kinds: ["doctor.ping"] });
    const mine = (claimed as { id: number }[] | null)?.find((j) => j.id === jobId);
    if (cErr || !mine) bad(`claim_jobs: ${cErr?.message ?? "job not claimed"}`);
    else {
      await db.rpc("complete_job", { p_id: mine.id, p_result: { ok: true } });
      await db.from("jobs").delete().eq("id", mine.id);
      ok("enqueue → claim → complete round trip");
    }
  }

  if (optionalEnv(llmKey)) {
    console.log("\nLLM");
    try {
      const { generateText } = await import("@/lib/ai/llm");
      const t0 = Date.now();
      const out = await generateText({ system: "Reply with exactly: ok", prompt: "ping", effort: "low", maxTokens: 400 });
      ok(`${provider} replied in ${Date.now() - t0}ms: ${JSON.stringify(out.slice(0, 40))}`);
    } catch (e) {
      bad(`LLM call failed: ${(e as Error).message}`);
    }
  }
  console.log(process.exitCode ? "\nSome checks failed." : "\nAll checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
