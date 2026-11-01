import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { searchKnowledge } from "@/lib/knowledge/process";
import { importPersonFromCrm } from "@/lib/integrations/crm";
import { createAdminClient } from "@/lib/supabase/admin";

// Tools the chat assistant can call. Every read runs through the user's
// RLS-scoped client, so the assistant can only see what the user can see.
// Writes are limited to low-risk actions (tasks, lists) and are confirmed
// in the conversation first.

export interface ToolContext {
  db: SupabaseClient;       // user-scoped (RLS)
  workspaceId: string;
  userId: string;
}

interface ToolDef<S extends z.ZodType> {
  def: Anthropic.Beta.BetaTool;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
  label: string;
}

function tool<S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> {
  return t;
}

const SearchProspects = z.object({
  query: z.string().optional(),
  tier: z.enum(["S", "A", "B", "C"]).optional(),
  status: z.string().optional(),
  window_closing_within_days: z.number().int().optional(),
  include_unqualified: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const GetProspect = z.object({ account_id: z.string().optional(), company_name: z.string().optional() });
const SearchKb = z.object({ query: z.string().min(2) });
const CreateTask = z.object({ title: z.string().min(2), account_id: z.string().optional(), due_on: z.string().optional() });
const AddToList = z.object({ account_ids: z.array(z.string()).min(1), list_name: z.string().min(1) });
const Empty = z.object({});
const ImportCrmPerson = z.object({ email: z.string().email(), confirmed: z.literal(true) });

export const CHAT_TOOLS = [
  tool({
    label: "Searching prospects",
    schema: SearchProspects,
    def: {
      name: "search_prospects",
      description: "Search this workspace's prospects (qualified accounts by default). Returns company, tier, score, reason to buy, contact window, top contact, warm-path count. Use for questions like 'who should I call this week', 'tier S in Ohio', 'windows closing soon'.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text matched against company name, reason to buy and industry" },
          tier: { type: "string", enum: ["S", "A", "B", "C"] },
          status: { type: "string", description: "Pipeline status: prospect, contacted, engaged, meeting, opportunity, customer, lost" },
          window_closing_within_days: { type: "integer", description: "Only prospects whose contact window ends within N days" },
          include_unqualified: { type: "boolean", description: "Also include watched companies that have not qualified" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
    async run(i, { db, workspaceId }) {
      let q = db.from("prospect_rows")
        .select("id, company_name, city, state, industry, tier, score, research_status, status, reason_to_buy, timing_label, contact_window_start, contact_window_end, top_contact_name, top_contact_title, warm_path_count, is_synthetic")
        .eq("workspace_id", workspaceId);
      if (!i.include_unqualified) q = q.eq("research_status", "qualified");
      if (i.tier) q = q.eq("tier", i.tier);
      if (i.status) q = q.eq("status", i.status);
      if (i.window_closing_within_days != null) {
        q = q.lte("contact_window_end", new Date(Date.now() + i.window_closing_within_days * 86_400_000).toISOString().slice(0, 10))
          .gte("contact_window_end", new Date().toISOString().slice(0, 10));
      }
      if (i.query) {
        const s = i.query.replace(/[%,()]/g, "");
        q = q.or(`company_name.ilike.%${s}%,reason_to_buy.ilike.%${s}%,industry.ilike.%${s}%,state.ilike.${s}`);
      }
      const { data, error } = await q.order("score", { ascending: false, nullsFirst: false }).limit(i.limit ?? 15);
      if (error) throw new Error(error.message);
      return data;
    },
  }),
  tool({
    label: "Reading a buyer profile",
    schema: GetProspect,
    def: {
      name: "get_prospect",
      description: "Full buyer profile for one account: reason to buy, why, reasoning, the dated records behind it (with notes), contact window, people to reach (with verification status), warm intro paths and open tasks. Pass account_id from search results, or company_name.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { account_id: { type: "string" }, company_name: { type: "string" } } },
    },
    async run(i, { db, workspaceId }) {
      let id = i.account_id;
      if (!id && i.company_name) {
        const { data } = await db.from("prospect_rows").select("id").eq("workspace_id", workspaceId).ilike("company_name", `%${i.company_name.replace(/[%,()]/g, "")}%`).order("score", { ascending: false }).limit(1).maybeSingle();
        id = data?.id;
      }
      if (!id) return { error: "No matching account" };
      const [acc, ev, contacts, warm, tasks] = await Promise.all([
        db.from("accounts").select("id, research_status, status, tier, score, fit_score, activity_score, reason_to_buy, why, reasoning, timing_label, readiness, confidence, contact_window_start, contact_window_end, next_step, companies(name, city, state, industry, employee_count, domain, is_synthetic)").eq("id", id).eq("workspace_id", workspaceId).single(),
        db.from("account_evidence").select("note, signals(title, detail, occurred_on, category, source)").eq("account_id", id).order("position"),
        db.from("contacts").select("full_name, title, role_tag, email, email_status, phone, unsubscribed_at").eq("account_id", id),
        db.from("warm_paths").select("explanation, strength").eq("account_id", id).order("strength", { ascending: false }),
        db.from("tasks").select("title, due_on").eq("account_id", id).eq("status", "open"),
      ]);
      return { account: acc.data, evidence: ev.data, contacts: contacts.data, warm_paths: warm.data, open_tasks: tasks.data };
    },
  }),
  tool({
    label: "Searching your knowledge base",
    schema: SearchKb,
    def: {
      name: "search_knowledge",
      description: "Search the workspace's knowledge base (website pages, playbooks, product docs) for passages relevant to a question about what the company sells, its customers, positioning or proof points.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    async run(i, { db, workspaceId }) {
      return (await searchKnowledge(db, workspaceId, i.query, 6)).map((r) => ({ document: r.document_name, passage: r.content }));
    },
  }),
  tool({
    label: "Reading your ICP",
    schema: Empty,
    def: {
      name: "get_icp_and_coverage",
      description: "The workspace's ICP segments (criteria, buyer roles, signal weights), the seller profile, and coverage numbers: companies watched vs qualified per segment, tier counts, qualified accounts without contacts or warm paths. Use for questions about targeting gaps or whether the ICP is too narrow/broad.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: {} },
    },
    async run(_i, { db, workspaceId }) {
      const [icps, seller, stats, accts] = await Promise.all([
        db.from("icps").select("id, name, description, criteria, buyer_roles, signal_preferences, is_primary").eq("workspace_id", workspaceId).eq("is_active", true),
        db.from("seller_profiles").select("summary, buying_triggers, buyer_problems").eq("workspace_id", workspaceId).maybeSingle(),
        db.rpc("workspace_stats", { p_workspace_id: workspaceId }),
        db.from("accounts").select("icp_id, research_status").eq("workspace_id", workspaceId).limit(5000),
      ]);
      const bySegment: Record<string, { watched: number; qualified: number; not_now: number; disqualified: number }> = {};
      for (const a of accts.data ?? []) {
        const k = (a.icp_id as string) ?? "none";
        bySegment[k] ??= { watched: 0, qualified: 0, not_now: 0, disqualified: 0 };
        bySegment[k].watched++;
        if (a.research_status === "qualified") bySegment[k].qualified++;
        if (a.research_status === "not_now") bySegment[k].not_now++;
        if (a.research_status === "disqualified") bySegment[k].disqualified++;
      }
      return { icps: icps.data, seller_profile: seller.data, stats: stats.data, by_segment: bySegment };
    },
  }),
  tool({
    label: "Creating a task",
    schema: CreateTask,
    def: {
      name: "create_task",
      description: "Create a task for the current user, optionally tied to an account. Only call after the user has asked for it or agreed to it.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { title: { type: "string" }, account_id: { type: "string" }, due_on: { type: "string", description: "YYYY-MM-DD" } },
        required: ["title"],
      },
    },
    async run(i, { db, workspaceId, userId }) {
      const { data, error } = await db.from("tasks").insert({
        workspace_id: workspaceId, account_id: i.account_id ?? null, title: i.title, due_on: i.due_on ?? null,
        assignee_id: userId, created_by: userId, source: "chat", kind: "custom",
      }).select("id").single();
      if (error) throw new Error(error.message);
      return { created: data.id };
    },
  }),
  tool({
    label: "Adding to a list",
    schema: AddToList,
    def: {
      name: "add_to_list",
      description: "Add accounts to a named list (created if missing). Lists sync to the CRM. Only call after the user has asked for it or agreed to it.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { account_ids: { type: "array", items: { type: "string" } }, list_name: { type: "string" } },
        required: ["account_ids", "list_name"],
      },
    },
    async run(i, { db, workspaceId, userId }) {
      let { data: list } = await db.from("lists").select("id").eq("workspace_id", workspaceId).eq("name", i.list_name).maybeSingle();
      if (!list) list = (await db.from("lists").insert({ workspace_id: workspaceId, name: i.list_name, created_by: userId }).select("id").single()).data;
      if (!list) throw new Error("Could not create list");
      const { error } = await db.from("list_members").upsert(
        i.account_ids.map((account_id) => ({ list_id: list!.id, account_id, workspace_id: workspaceId })),
        { onConflict: "list_id,account_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
      return { list: i.list_name, added: i.account_ids.length };
    },
  }),
];

// CRM import: lets chat add a CRM-only person, gated on explicit user confirmation.
CHAT_TOOLS.push(
  tool({
    label: "Adding a person from your CRM",
    schema: ImportCrmPerson,
    def: {
      name: "import_crm_person",
      description:
        "Add a person who exists only in the connected CRM (HubSpot or Attio) to Tidemark, linked to their company. People who exist only in the CRM stay out of Tidemark unless a member asks — so ONLY call this after the user explicitly asked to add that person AND confirmed in a separate message. Set confirmed=true only then.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { email: { type: "string", description: "The person's email in the CRM" }, confirmed: { type: "boolean", enum: [true] } },
        required: ["email", "confirmed"],
      },
    },
    async run(i, { db, workspaceId, userId }) {
      const { data: conns } = await db.from("integration_connections").select("id, provider").eq("workspace_id", workspaceId).in("provider", ["hubspot", "attio"]).eq("status", "active");
      if (!conns?.length) return { error: "No CRM connected. Connect HubSpot or Attio in Settings → Integrations." };
      const results = [];
      for (const c of conns) {
        const r = await importPersonFromCrm(createAdminClient(), c.id as string, i.email, { workspaceId, userId });
        results.push(r);
        if (r.status !== "not_found") break;
      }
      return results;
    },
  }) as unknown as (typeof CHAT_TOOLS)[number],
);

export const CHAT_TOOL_DEFS: Anthropic.Beta.BetaTool[] = CHAT_TOOLS.map((t) => t.def);

export async function runChatTool(name: string, input: unknown, ctx: ToolContext): Promise<{ ok: boolean; content: string; label: string }> {
  const t = CHAT_TOOLS.find((x) => x.def.name === name);
  if (!t) return { ok: false, content: `Unknown tool ${name}`, label: name };
  const parsed = t.schema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.map((i) => i.message) }), label: t.label };
  try {
    const result = await (t.run as (i: unknown, c: ToolContext) => Promise<unknown>)(parsed.data, ctx);
    return { ok: true, content: JSON.stringify(result ?? null).slice(0, 60_000), label: t.label };
  } catch (e) {
    return { ok: false, content: (e as Error).message, label: t.label };
  }
}

