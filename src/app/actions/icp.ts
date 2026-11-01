"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { suggestIcp } from "@/lib/knowledge/process";
import { enqueue } from "@/lib/jobs";
import type { BuyerRole, IcpCriteria, SignalPreferences } from "@/lib/types";

export interface IcpDraft {
  id?: string;
  name: string;
  description: string | null;
  criteria: IcpCriteria;
  buyer_roles: BuyerRole[];
  signal_preferences: SignalPreferences;
  is_primary?: boolean;
}

/** Claude drafts an ICP from the seller profile + the user's description. */
export async function draftIcp(input: { bestCustomers?: string; targetCompanies?: string }): Promise<{ draft?: IcpDraft; error?: string }> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { error: "No workspace" };
  try {
    const draft = await suggestIcp(createAdminClient(), ctx.workspace.id, input);
    return { draft };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function saveIcp(draft: IcpDraft) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { error: "No workspace" };
  const supabase = await createClient();
  const { count } = await supabase.from("icps").select("id", { count: "exact", head: true }).eq("workspace_id", ctx.workspace.id);
  // Tidemark targets manufacturers: an ICP with no industries means "all of manufacturing" (NAICS 31–33), not "everything".
  const criteria = { ...draft.criteria };
  if (!criteria.industries?.length) {
    criteria.industries = [
      { naics_prefix: "31", label: "Manufacturing — food, beverage, textiles" },
      { naics_prefix: "32", label: "Manufacturing — wood, paper, chemicals, plastics" },
      { naics_prefix: "33", label: "Manufacturing — metals, machinery, electronics, vehicles" },
    ];
  }
  const row = {
    workspace_id: ctx.workspace.id,
    name: draft.name.trim() || "Primary",
    description: draft.description,
    criteria,
    buyer_roles: draft.buyer_roles,
    signal_preferences: draft.signal_preferences,
    is_primary: draft.is_primary ?? (count ?? 0) === 0,
    created_by: ctx.user.id,
  };
  const { data, error } = draft.id
    ? await supabase.from("icps").update(row).eq("id", draft.id).eq("workspace_id", ctx.workspace.id).select("id").single()
    : await supabase.from("icps").insert(row).select("id").single();
  if (error) return { error: error.message };
  await enqueue("workspace.match", { workspaceId: ctx.workspace.id, icpId: data.id }, { workspaceId: ctx.workspace.id, dedupeKey: `match:${ctx.workspace.id}:${data.id}`, priority: 20 });
  // Re-score accounts already on this ICP.
  const { data: accts } = await supabase.from("accounts").select("id").eq("icp_id", data.id).limit(2000);
  for (const a of accts ?? []) {
    await enqueue("account.research", { accountId: a.id, force: true }, { workspaceId: ctx.workspace.id, dedupeKey: `research:${a.id}`, priority: 95 });
  }
  revalidatePath("/settings/icp");
  return { ok: true, id: data.id as string };
}

export async function setPrimaryIcp(id: string) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return;
  const supabase = await createClient();
  await supabase.from("icps").update({ is_primary: false }).eq("workspace_id", ctx.workspace.id).eq("is_primary", true);
  await supabase.from("icps").update({ is_primary: true }).eq("id", id).eq("workspace_id", ctx.workspace.id);
  revalidatePath("/settings/icp");
}

export async function archiveIcp(id: string) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return;
  const supabase = await createClient();
  await supabase.from("icps").update({ is_active: false, is_primary: false }).eq("id", id).eq("workspace_id", ctx.workspace.id);
  revalidatePath("/settings/icp");
}
