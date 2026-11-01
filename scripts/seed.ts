// Loads the synthetic demo dataset into the shared company graph and,
// optionally, into a workspace (demo contacts + watchlist + research jobs).
//   npm run seed                      → companies + records + signals only
//   npm run seed -- --workspace <id>  → also that workspace's contacts and accounts
//
// Every demo company is fictional, flagged is_synthetic, and uses a reserved
// *.example domain, so nothing can be confused with (or emailed at) a real business.
import { createAdminClient } from "@/lib/supabase/admin";
import { loadDemoData } from "@/lib/seed/load";

async function main() {
  const i = process.argv.indexOf("--workspace");
  const workspaceId = i > -1 ? process.argv[i + 1] : null;
  const r = await loadDemoData(createAdminClient(), workspaceId);
  console.log(`seeded ${r.companies} demo companies, ${r.records} records, ${r.signals} signals`);
  if (r.matched) console.log(`watchlist: +${r.matched.added} accounts, ${r.matched.queued} research jobs queued — run \`npm run worker\``);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
