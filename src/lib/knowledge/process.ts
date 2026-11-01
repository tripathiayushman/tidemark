import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { generateStructured } from "@/lib/ai/llm";
import { enqueue } from "@/lib/jobs";
import type { BuyerRole, IcpCriteria, SignalPreferences } from "@/lib/types";
import { embed, toPgVector } from "./embed";
import { chunkText, extractText, htmlToText } from "./extract";

// Knowledge base pipeline:
//   upload / website → text → chunks (+ optional embeddings)
//   → seller profile (what we sell, to whom, which events create need)
//   → suggested ICP (industries as NAICS prefixes, size, geography, buyer roles)

export async function processDocument(db: SupabaseClient, documentId: string) {
  const { data: doc } = await db.from("kb_documents").select("*").eq("id", documentId).single();
  if (!doc) throw new Error("document not found");
  await db.from("kb_documents").update({ status: "processing", error: null }).eq("id", documentId);
  try {
    let extracted: { text: string; columns?: number; rows?: number };
    if (doc.kind === "upload") {
      const { data: file, error } = await db.storage.from("knowledge").download(doc.storage_path);
      if (error || !file) throw new Error(`download: ${error?.message ?? "missing file"}`);
      extracted = await extractText(Buffer.from(await file.arrayBuffer()), doc.mime_type, doc.name);
    } else if (doc.kind === "website") {
      extracted = { text: await crawlSite(doc.source_url) };
    } else {
      // notes keep their text in summary
      extracted = { text: doc.summary ?? "" };
    }
    const chunks = chunkText(extracted.text);
    if (!chunks.length) throw new Error("No readable text found in this document");
    const vectors = await embed(chunks, "document").catch((e) => {
      console.warn(`[kb] embeddings skipped: ${(e as Error).message}`);
      return null;
    });
    await db.from("kb_chunks").delete().eq("document_id", documentId);
    for (let i = 0; i < chunks.length; i += 200) {
      const rows = chunks.slice(i, i + 200).map((content, j) => ({
        workspace_id: doc.workspace_id,
        document_id: documentId,
        chunk_index: i + j,
        content,
        embedding: vectors ? toPgVector(vectors[i + j]) : null,
      }));
      const { error } = await db.from("kb_chunks").insert(rows);
      if (error) throw new Error(`chunks: ${error.message}`);
    }
    await db
      .from("kb_documents")
      .update({
        status: "ready",
        processed_at: new Date().toISOString(),
        char_count: extracted.text.length,
        column_count: extracted.columns ?? null,
        row_count: extracted.rows ?? null,
        size_bytes: doc.kind === "upload" ? doc.size_bytes : Buffer.byteLength(extracted.text),
      })
      .eq("id", documentId);
    await enqueue("seller.profile", { workspaceId: doc.workspace_id }, { workspaceId: doc.workspace_id, dedupeKey: `seller:${doc.workspace_id}`, runAfter: new Date(Date.now() + 15_000) });
    return { chunks: chunks.length, embedded: Boolean(vectors) };
  } catch (e) {
    await db.from("kb_documents").update({ status: "failed", error: (e as Error).message.slice(0, 500) }).eq("id", documentId);
    throw e;
  }
}

/** Homepage + a handful of same-site pages that describe the business. */
export async function crawlSite(url: string, maxPages = 8): Promise<string> {
  const start = new URL(url.startsWith("http") ? url : `https://${url}`);
  const seen = new Set<string>();
  const queue = [start.toString()];
  const texts: string[] = [];
  const interesting = /(about|product|solution|service|industr|customer|case|platform|how-it-works|pricing|who-we|what-we)/i;
  while (queue.length && seen.size < maxPages) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      const res = await fetch(next, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "TidemarkBot/1.0 (knowledge import)" }, redirect: "follow" });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) continue;
      const html = await res.text();
      const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? next;
      texts.push(`# ${title}\n${htmlToText(html).slice(0, 12000)}`);
      if (seen.size === 1) {
        for (const m of html.matchAll(/href="([^"#]+)"/g)) {
          try {
            const u = new URL(m[1], start);
            if (u.host === start.host && interesting.test(u.pathname) && !seen.has(u.toString())) queue.push(u.toString());
          } catch { /* ignore bad hrefs */ }
        }
      }
    } catch { /* skip unreachable pages */ }
  }
  if (!texts.length) throw new Error(`Could not read ${start.host}`);
  return texts.join("\n\n");
}

// ── Seller profile ─────────────────────────────────────────────────────────
const SellerSchema = z.object({
  summary: z.string().describe("One paragraph: what the company sells and to whom"),
  offerings: z.array(z.object({ name: z.string(), description: z.string() })),
  buyer_problems: z.array(z.string()).describe("Problems buyers have that the offering solves"),
  proof_points: z.array(z.string()).describe("Customers, results or credentials stated in the material"),
  differentiators: z.array(z.string()),
  competitors: z.array(z.string()).describe("Only competitors named in the material"),
  buying_triggers: z.array(z.string()).describe("Observable company events that create need for this offering, phrased as events (e.g. 'opens a new production line', 'wins a large defense contract')"),
});

export async function buildSellerProfile(db: SupabaseClient, workspaceId: string) {
  const { data: chunks } = await db
    .from("kb_chunks")
    .select("content, kb_documents(name)")
    .eq("workspace_id", workspaceId)
    .order("chunk_index", { ascending: true })
    .limit(120);
  if (!chunks?.length) return { updated: false };
  const corpus = chunks
    .map((c) => `[${(c.kb_documents as unknown as { name: string } | null)?.name ?? "doc"}] ${c.content}`)
    .join("\n\n")
    .slice(0, 150_000);
  const { data } = await generateStructured({
    system: "You distill a B2B company's own materials into a precise seller profile. Use only what the material states; leave a list empty rather than guess.",
    prompt: `Company materials:\n\n${corpus}`,
    schema: SellerSchema,
    effort: "medium",
  });
  await db.from("seller_profiles").upsert({ workspace_id: workspaceId, ...data, updated_at: new Date().toISOString() });
  return { updated: true };
}

// ── ICP suggestion ─────────────────────────────────────────────────────────
const IcpSchema = z.object({
  name: z.string().describe("Segment name, e.g. 'Mid-market fabricators'"),
  description: z.string(),
  industries: z.array(z.object({ naics_prefix: z.string().describe("2-6 digit NAICS prefix, manufacturing is 31-33"), label: z.string() })),
  employee_min: z.number().int().nullable(),
  employee_max: z.number().int().nullable(),
  states: z.array(z.string()).describe("Two-letter state codes; empty for nationwide"),
  keywords: z.array(z.string()).describe("Words that indicate fit in a company's name or description"),
  exclude_keywords: z.array(z.string()),
  buyer_roles: z.array(z.object({
    title: z.string(),
    role_tag: z.enum(["decision_maker", "runs_the_build", "champion", "influencer", "other"]),
    seniority: z.string(),
    title_keywords: z.array(z.string()),
  })),
  signal_weights: z.object({
    money_moving: z.number(), building: z.number(), equipment_supply: z.number(), contracts: z.number(), operations: z.number(),
  }).describe("0 to 2: how much each signal category matters for this seller (1 = normal)"),
});

export async function suggestIcp(db: SupabaseClient, workspaceId: string, extra?: { bestCustomers?: string; targetCompanies?: string }) {
  const [{ data: seller }, { data: ws }] = await Promise.all([
    db.from("seller_profiles").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    db.from("workspaces").select("name, website").eq("id", workspaceId).single(),
  ]);
  const { data } = await generateStructured({
    system:
      "You design an ideal customer profile for a B2B seller whose buyers are US manufacturers. Express industries as NAICS prefixes (31-33). " +
      "Be specific enough to rank companies, but not so narrow that nothing matches. Buyer roles should be the people who would decide on and run this purchase at a plant.",
    prompt: [
      `Seller: ${ws?.name ?? ""} ${ws?.website ?? ""}`,
      seller ? `Seller profile: ${JSON.stringify(seller)}` : "No seller profile yet.",
      extra?.bestCustomers ? `Best customers, in the seller's words: ${extra.bestCustomers}` : "",
      extra?.targetCompanies ? `Example target companies: ${extra.targetCompanies}` : "",
    ].filter(Boolean).join("\n\n"),
    schema: IcpSchema,
    effort: "medium",
  });
  const criteria: IcpCriteria = {
    industries: data.industries,
    employee_min: data.employee_min,
    employee_max: data.employee_max,
    states: data.states,
    keywords: data.keywords,
    exclude_keywords: data.exclude_keywords,
  };
  const buyer_roles: BuyerRole[] = data.buyer_roles;
  const signal_preferences: SignalPreferences = { weights: data.signal_weights, lookback_days: 540, min_corroborating: 2 };
  return { name: data.name, description: data.description, criteria, buyer_roles, signal_preferences };
}

/** Knowledge search used by chat (hybrid FTS + optional vectors). */
export async function searchKnowledge(db: SupabaseClient, workspaceId: string, query: string, limit = 6) {
  const vec = await embed([query], "query").catch(() => null);
  const { data, error } = await db.rpc("search_kb", {
    p_workspace_id: workspaceId,
    p_query: query,
    p_embedding: vec ? toPgVector(vec[0]) : null,
    p_limit: limit,
  });
  if (error) throw new Error(`search_kb: ${error.message}`);
  return (data ?? []) as { chunk_id: number; document_id: string; document_name: string; content: string; rank: number }[];
}
