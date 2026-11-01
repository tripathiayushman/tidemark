// Local worker loop: drains the job queue continuously.
//   npm run worker            (loops forever)
//   npm run worker -- --once  (one tick, then exit)
import { tick } from "@/lib/worker/runner";

async function main() {
  const once = process.argv.includes("--once");
  for (;;) {
    const started = Date.now();
    try {
      const { scheduled, ran } = await tick({ budgetMs: 55_000 });
      if (scheduled.length) console.log(`[worker] scheduled: ${scheduled.join(", ")}`);
      for (const r of ran) console.log(`[worker] ${r.ok ? "✓" : "✗"} #${r.id} ${r.kind} ${r.ms}ms${r.error ? ` — ${r.error}` : ""}`);
      if (once) return;
      if (!ran.length) await new Promise((r) => setTimeout(r, Math.max(2_000, 10_000 - (Date.now() - started))));
    } catch (e) {
      console.error("[worker] tick failed:", (e as Error).message);
      if (once) process.exit(1);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

main();
