import type { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getWorkspaceContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";
import { claude, FALLBACK_BETA, model } from "@/lib/ai/claude";
import { CHAT_TOOL_DEFS, runChatTool } from "@/lib/ai/chat-tools";
import { runOpenRouterChat, toOpenRouterHistory, type ORMessage } from "@/lib/ai/chat-openrouter";
import { LlmRateLimitError } from "@/lib/ai/llm";

// Streaming chat over Server-Sent Events, on OpenRouter or Claude.
//   * History is append-only and replayed exactly from chat_messages.
//   * Tool loop with validated inputs; workspace-scoped (RLS) tools only.

export const maxDuration = 120;

const SYSTEM = `You are Tidemark's assistant for a B2B sales team that sells to US manufacturers.

You help the team decide who to contact and why, using the workspace's own data through tools: prospects with dated public-record evidence, buyer profiles, the ICP and coverage numbers, and the knowledge base about what the team sells.

How to work:
- Look things up with tools instead of guessing. Cite companies by name and the specific records behind a claim (e.g. "the SBA 504 loan in June and the permit closed out in September").
- When asked who to contact, rank by fit and timing: tier, how soon the contact window closes, whether a warm intro exists, and whether a verified decision maker is on file.
- For targeting questions, use coverage numbers: segments with many watched companies but few qualified suggest the ICP or signal weights need adjusting; say what you'd change.
- Before creating tasks, adding accounts to lists, or importing a CRM person, confirm with the user unless they explicitly asked for it.
- Companies marked is_synthetic are demo data; mention that if it matters.
- Be concise. Use short lists or a compact table when comparing several accounts. No hype.`;

const MAX_STEPS = 8;

export async function POST(request: NextRequest) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  const body = (await request.json().catch(() => null)) as { threadId?: string; message?: string } | null;
  const text = body?.message?.trim();
  if (!text) return new Response("Empty message", { status: 400 });

  const db = await createClient();
  let threadId = body?.threadId ?? null;
  if (threadId) {
    const { data } = await db.from("chat_threads").select("id").eq("id", threadId).eq("user_id", ctx.user.id).maybeSingle();
    if (!data) threadId = null;
  }
  if (!threadId) {
    const { data, error } = await db
      .from("chat_threads")
      .insert({ workspace_id: ctx.workspace.id, user_id: ctx.user.id, title: text.slice(0, 80) })
      .select("id")
      .single();
    if (error) return new Response(error.message, { status: 500 });
    threadId = data.id as string;
  }

  const { data: rows } = await db.from("chat_messages").select("role, content, display_text").eq("thread_id", threadId).order("id");
  const provider = serverEnv.llmProvider();
  const toolCtx = { db, workspaceId: ctx.workspace.id, userId: ctx.user.id };
  const insert = (role: "user" | "assistant", content: unknown, display: string | null) =>
    db.from("chat_messages").insert({ thread_id: threadId, workspace_id: ctx.workspace.id, role, content, display_text: display });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ type: "thread", id: threadId });
      try {
        if (provider === "openrouter") {
          const userMsg: ORMessage = { role: "user", content: text };
          await insert("user", { provider: "openrouter", messages: [userMsg] }, text);
          const history = [...toOpenRouterHistory(rows ?? []), userMsg];
          await runOpenRouterChat(SYSTEM, history, toolCtx, {
            onText: (t) => send({ type: "text", text: t }),
            onTool: (e) => send({ type: "tool", ...e }),
            persist: async (role, messages, display) => { await insert(role, { provider: "openrouter", messages }, display); },
          });
        } else {
          await runAnthropicChat(rows ?? [], text, toolCtx, insert, send);
        }
        await db.from("chat_threads").update({ updated_at: new Date().toISOString() }).eq("id", threadId);
        send({ type: "done" });
      } catch (e) {
        const msg =
          e instanceof LlmRateLimitError ? "The free model's rate limit was reached — try again in a minute (or add OpenRouter credits for a higher daily limit)."
          : e instanceof Anthropic.RateLimitError ? "Claude is rate-limited right now — try again in a moment."
          : e instanceof Anthropic.AuthenticationError ? "The Anthropic API key is missing or invalid."
          : (e as Error).message;
        send({ type: "error", message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}

async function runAnthropicChat(
  rows: { role: string; content: unknown; display_text: string | null }[],
  text: string,
  toolCtx: Parameters<typeof runChatTool>[2],
  insert: (role: "user" | "assistant", content: unknown, display: string | null) => PromiseLike<unknown>,
  send: (obj: unknown) => void,
) {
  // Only replay rows written by the Anthropic path (arrays of content blocks).
  const messages: Anthropic.Beta.BetaMessageParam[] = rows
    .filter((r) => Array.isArray(r.content))
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content as Anthropic.Beta.BetaContentBlockParam[] }));
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text }];
  messages.push({ role: "user", content: userContent });
  await insert("user", userContent, text);

  for (let step = 0; step < MAX_STEPS; step++) {
    const s = claude().beta.messages.stream({
      model: model(),
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: CHAT_TOOL_DEFS,
      messages,
    });
    s.on("text", (delta) => send({ type: "text", text: delta }));
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await s.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError || step >= MAX_STEPS - 1) throw err;
      continue; // unparsable tool-input JSON: re-issue the turn
    }
    messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
    const finalText = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    await insert("assistant", message.content, finalText || null);
    if (message.stop_reason === "refusal") { send({ type: "text", text: "\n\nI can't help with that request." }); break; }
    if (message.stop_reason === "pause_turn") continue;
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        send({ type: "tool", name: tu.name, status: "start" });
        const r = await runChatTool(tu.name, tu.input, toolCtx);
        send({ type: "tool", name: tu.name, label: r.label, status: r.ok ? "done" : "error" });
        return { type: "tool_result" as const, tool_use_id: tu.id, content: r.content, is_error: !r.ok };
      }),
    );
    messages.push({ role: "user", content: results });
    await insert("user", results, null);
  }
}
