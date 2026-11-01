"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { enqueue } from "@/lib/jobs";

export async function regenerateInsights() {
  const ctx = await getWorkspaceContext();
  if (!ctx) return;
  await enqueue("insights.generate", { workspaceId: ctx.workspace.id }, { workspaceId: ctx.workspace.id, dedupeKey: `insights:${ctx.workspace.id}`, priority: 20 });
}

export async function dismissInsight(id: string) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return;
  const supabase = await createClient();
  await supabase.from("insights").update({ dismissed_at: new Date().toISOString() }).eq("id", id).eq("workspace_id", ctx.workspace.id);
  revalidatePath("/insights");
}
