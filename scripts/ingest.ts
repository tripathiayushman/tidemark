// Run a connector against the database right now (instead of waiting for the schedule).
//   npm run ingest -- usaspending.contracts [limit] [sinceDays]
import { createAdminClient } from "@/lib/supabase/admin";
import { runConnector } from "@/lib/pipeline/ingest";
import { CONNECTORS } from "@/lib/sources";
import { isoDaysAgo } from "@/lib/pipeline/normalize";

async function main() {
  const [id, limit, days] = process.argv.slice(2);
  if (!id) {
    console.log("Usage: npm run ingest -- <connector> [limit] [sinceDays]\n");
    for (const c of CONNECTORS) console.log(`  ${c.id.padEnd(36)} ${c.disabledReason() ?? "ready"}`);
    return;
  }
  const res = await runConnector(createAdminClient(), id, {
    limit: limit ? Number(limit) : undefined,
    since: days ? isoDaysAgo(Number(days)) : undefined,
    resolveBudgetMs: 10 * 60_000, // CLI: resolve everything now
  });
  console.log(JSON.stringify({ connector: res.connector, fetched: res.fetched, inserted: res.inserted, resolved: res.resolved }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
