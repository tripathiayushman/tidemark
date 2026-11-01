import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { generateStructured } from "@/lib/ai/llm";

// Drafts a short, specific email for one contact at a qualified account,
// grounded in the account's evidence. Used by Gmail campaigns (per step) and
// by the Instantly push (first email only).

const DraftSchema = z.object({
  subject: z.string().describe("Under 8 words, lowercase-friendly, no clickbait. Empty string for a follow-up that replies in-thread."),
  body: z.string().describe("Plain text, 60-120 words, no links, no signature block, no unsubscribe line (added automatically)."),
});
export type Draft = z.infer<typeof DraftSchema>;

export async function draftEmail(
  db: SupabaseClient,
  p: { accountId: string; contactId: string; stepPosition: number; guidance?: string | null; previous?: { subject: string | null; body: string }[] },
): Promise<Draft> {
  const [{ data: acc }, { data: contact }, { data: evidence }] = await Promise.all([
    db.from("accounts").select("workspace_id, reason_to_buy, why, timing_label, companies(name, city, state)").eq("id", p.accountId).single(),
    db.from("contacts").select("full_name, first_name, title").eq("id", p.contactId).single(),
    db.from("account_evidence").select("note, signals(title, detail, occurred_on)").eq("account_id", p.accountId).order("position"),
  ]);
  if (!acc || !contact) throw new Error("account or contact missing");
  const { data: seller } = await db.from("seller_profiles").select("summary, offerings, proof_points").eq("workspace_id", acc.workspace_id).maybeSingle();
  const company = acc.companies as unknown as { name: string; city: string | null; state: string | null };

  const { data } = await generateStructured({
    system:
      "You write cold outreach emails for a B2B seller to a manufacturer. Rules: reference one or two specific public records (by what they are, e.g. 'the permit on the new building'), " +
      "connect them to one concrete thing the seller does, ask one low-friction question. Never claim private knowledge, never invent facts, never flatter. " +
      "Plain, human tone. Follow-ups are shorter and add one new angle; they never just 'bump'.",
    prompt: JSON.stringify({
      step: p.stepPosition === 0 ? "first email" : `follow-up #${p.stepPosition}`,
      seller,
      recipient: { name: contact.full_name, first_name: contact.first_name, title: contact.title },
      company,
      reason_to_buy: acc.reason_to_buy,
      why: acc.why,
      timing: acc.timing_label,
      evidence: (evidence ?? []).map((e) => ({ note: e.note, record: e.signals })),
      guidance: p.guidance ?? null,
      previous_emails: p.previous ?? [],
    }),
    schema: DraftSchema,
    effort: "low",
    maxTokens: 4000,
  });
  return data;
}
