import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { generateStructured } from "@/lib/ai/llm";

// Insights page: a few grounded observations about targeting, computed from
// the workspace's own numbers and then phrased by Claude. Every number in an
// insight comes from the stats object, never from the model.

const InsightSchema = z.object({
  insights: z.array(
    z.object({
      kind: z.enum(["targeting_gap", "segment_performance", "window_closing", "coverage"]),
      title: z.string().describe("Short headline, max ~10 words"),
      body: z.string().describe("2-3 sentences. Use only numbers present in the data."),
    }),
  ).max(5),
});

export async function generateInsights(db: SupabaseClient, workspaceId: string) {
  const { data: stats } = await db.rpc("workspace_stats", { p_workspace_id: workspaceId });
  const { data: byIcp } = await db
    .from("accounts")
    .select("icp_id, research_status, tier, icps(name)")
    .eq("workspace_id", workspaceId)
    .limit(5000);
  const segments: Record<string, { watched: number; qualified: number; s: number }> = {};
  for (const a of byIcp ?? []) {
    const name = (a.icps as unknown as { name: string } | null)?.name ?? "Unassigned";
    segments[name] ??= { watched: 0, qualified: 0, s: 0 };
    segments[name].watched++;
    if (a.research_status === "qualified") segments[name].qualified++;
    if (a.tier === "S" && a.research_status === "qualified") segments[name].s++;
  }
  const { data: closing } = await db
    .from("prospect_rows")
    .select("company_name, contact_window_end, warm_path_count, top_contact_name")
    .eq("workspace_id", workspaceId)
    .eq("research_status", "qualified")
    .lte("contact_window_end", new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10))
    .order("contact_window_end")
    .limit(10);
  const { data: noContact } = await db
    .from("prospect_rows")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("research_status", "qualified")
    .is("top_contact_id", null);

  const facts = { stats, segments, windows_closing_soon: closing ?? [], qualified_without_contacts: (noContact as unknown as number) ?? null };
  const { data } = await generateStructured({
    system:
      "You write short, factual insights for a sales team's prospecting dashboard. Use only the numbers in the data. " +
      "Point out targeting gaps (segments with many watched but few qualified), coverage gaps (qualified accounts without contacts or warm paths), and windows that close soon. No hype.",
    prompt: JSON.stringify(facts),
    schema: InsightSchema,
    effort: "low",
    maxTokens: 4000,
  });
  await db.from("insights").delete().eq("workspace_id", workspaceId).is("dismissed_at", null);
  if (data.insights.length) {
    await db.from("insights").insert(data.insights.map((i) => ({ ...i, workspace_id: workspaceId, data: facts })));
  }
  return { insights: data.insights.length };
}
