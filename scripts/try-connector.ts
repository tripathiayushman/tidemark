// Dry-run a connector: fetch + parse + signal extraction, no database writes.
//   npx tsx scripts/try-connector.ts usaspending.contracts [limit] [sinceDays]
import { CONNECTORS, getConnector } from "@/lib/sources";
import { isoDaysAgo } from "@/lib/pipeline/normalize";

async function main() {
const [id, limitArg, daysArg] = process.argv.slice(2);
if (!id) {
  console.log("Connectors:\n" + CONNECTORS.map((c) => `  ${c.id.padEnd(36)} ${c.disabledReason() ?? "ready"}`).join("\n"));
  return;
}
const c = getConnector(id);
if (!c) throw new Error(`unknown connector ${id}`);
const since = isoDaysAgo(Number(daysArg ?? c.defaultLookbackDays));
const { records, metrics } = await c.fetch({ since, limit: Number(limitArg ?? 10), cursor: {}, log: (m) => console.log("  ·", m) });
console.log(`\n${records.length} records since ${since}${metrics ? `, ${metrics.length} metrics` : ""}\n`);
for (const r of records.slice(0, 5)) {
  const sigs = c.toSignals({ ...r, id: "dry", company_id: null });
  console.log(`- ${r.entity_name} (${[r.entity_city, r.entity_state].filter(Boolean).join(", ")}) ${r.occurred_on}`);
  for (const s of sigs) console.log(`    [${s.category}/${s.signal_type} ${s.strength}] ${s.title} — ${s.detail ?? ""}`);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
