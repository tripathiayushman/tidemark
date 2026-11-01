"use server";

import Papa from "papaparse";
import { revalidatePath } from "next/cache";
import { getWorkspaceContext, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueue } from "@/lib/jobs";
import { identityKey, parseLinkedInConnections } from "@/lib/pipeline/warm-paths";
import { getConnector } from "@/lib/sources";

/** User uploads their own LinkedIn "Connections.csv" (Settings → Data privacy → Get a copy of your data). */
export async function importLinkedInConnections(csvText: string) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { error: "No workspace" };
  // LinkedIn exports start with a few "Notes:" lines before the header row.
  const start = csvText.search(/^First Name,/m);
  const body = start >= 0 ? csvText.slice(start) : csvText;
  const parsed = Papa.parse<Record<string, string>>(body, { header: true, skipEmptyLines: true });
  const rows = parseLinkedInConnections(parsed.data);
  if (!rows.length) return { error: "No connections found — upload the Connections.csv file from your LinkedIn data export" };

  const supabase = await createClient();
  const admin = createAdminClient();
  let imported = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    // best-effort company link by name
    const names = [...new Set(chunk.map((r) => r.company_name).filter(Boolean))] as string[];
    const { data: companies } = names.length ? await admin.from("companies").select("id, name").in("name", names) : { data: [] };
    const byName = new Map((companies ?? []).map((c) => [String(c.name).toLowerCase(), c.id as string]));
    const { error, data } = await supabase.from("network_connections").upsert(
      chunk.map((r) => ({
        workspace_id: ctx.workspace.id,
        member_id: ctx.user.id,
        full_name: r.full_name,
        email: r.email,
        title: r.title,
        company_name: r.company_name,
        company_domain: r.company_domain,
        company_id: r.company_name ? byName.get(r.company_name.toLowerCase()) ?? null : null,
        linkedin_url: r.linkedin_url,
        source: "linkedin_export",
        connected_on: r.connected_on ? new Date(r.connected_on).toISOString().slice(0, 10) : null,
        identity_key: identityKey(r),
      })),
      { onConflict: "workspace_id,member_id,source,identity_key", ignoreDuplicates: false },
    ).select("id");
    if (error) return { error: error.message };
    imported += data?.length ?? 0;
  }
  await enqueue("workspace.warm_paths", { workspaceId: ctx.workspace.id }, { workspaceId: ctx.workspace.id, dedupeKey: `warm-all:${ctx.workspace.id}`, priority: 30 });
  revalidatePath("/settings/network");
  return { ok: true, imported };
}

export async function removeMyLinkedInConnections() {
  const ctx = await getWorkspaceContext();
  if (!ctx) return;
  const supabase = await createClient();
  await supabase.from("network_connections").delete().eq("workspace_id", ctx.workspace.id).eq("member_id", ctx.user.id).eq("source", "linkedin_export");
  await enqueue("workspace.warm_paths", { workspaceId: ctx.workspace.id }, { workspaceId: ctx.workspace.id, dedupeKey: `warm-all:${ctx.workspace.id}` });
  revalidatePath("/settings/network");
}

/** Admins can run a public-data connector now instead of waiting for the schedule. */
export async function runSourceNow(connectorId: string) {
  const ctx = await getWorkspaceContext();
  if (!ctx || !isAdmin(ctx.role)) return { error: "Only admins can run data sources" };
  const c = getConnector(connectorId);
  if (!c) return { error: "Unknown source" };
  if (c.disabledReason()) return { error: c.disabledReason()! };
  await enqueue("ingest.source", { connector: connectorId }, { dedupeKey: `ingest:${connectorId}`, priority: 5 });
  await enqueue("workspace.match", { workspaceId: ctx.workspace.id }, { workspaceId: ctx.workspace.id, dedupeKey: `match:${ctx.workspace.id}`, priority: 25, runAfter: new Date(Date.now() + 60_000) });
  revalidatePath("/settings/sources");
  return { ok: true };
}

