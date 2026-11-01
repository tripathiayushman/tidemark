import type Anthropic from "@anthropic-ai/sdk";
import { currentModel, openrouterHeaders, raiseForOpenRouter, reasoningFor } from "./llm";
import { CHAT_TOOL_DEFS, runChatTool, type ToolContext } from "./chat-tools";

// Chat turn over OpenRouter (OpenAI-compatible streaming + function calling).
// Messages are stored per row as { provider: "openrouter", messages: [...] }
// so history replays exactly; tool inputs are validated before they run.

export interface ORMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export const OR_TOOLS = CHAT_TOOL_DEFS.map((t: Anthropic.Beta.BetaTool) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description ?? "", parameters: t.input_schema as Record<string, unknown> },
}));

interface StreamCallbacks {
  onText: (delta: string) => void;
  onTool: (e: { name: string; label?: string; status: "start" | "done" | "error" }) => void;
  persist: (role: "user" | "assistant", messages: ORMessage[], displayText: string | null) => Promise<void>;
}

const MAX_STEPS = 8;

export async function runOpenRouterChat(system: string, history: ORMessage[], ctx: ToolContext, cb: StreamCallbacks) {
  const messages: ORMessage[] = [{ role: "system", content: system }, ...history];
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: openrouterHeaders(),
      body: JSON.stringify({
        model: currentModel(),
        stream: true,
        max_tokens: 8000,
        reasoning: reasoningFor("low"),
        tools: OR_TOOLS,
        messages,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok || !res.body) await raiseForOpenRouter(res);

    let text = "";
    let finish: string | null = null;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue; // ": OPENROUTER PROCESSING" keep-alives etc.
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let evt: {
          error?: { message?: string };
          choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
        };
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.error) throw new Error(`OpenRouter: ${evt.error.message ?? "stream error"}`);
        const ch = evt.choices?.[0];
        if (!ch) continue;
        if (ch.delta?.content) {
          text += ch.delta.content;
          cb.onText(ch.delta.content);
        }
        for (const tc of ch.delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }

    const toolCalls = [...calls.values()].filter((c) => c.name).map((c, i) => ({
      id: c.id || `call_${step}_${i}`,
      type: "function" as const,
      function: { name: c.name, arguments: c.args || "{}" },
    }));
    const assistant: ORMessage = { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    messages.push(assistant);
    await cb.persist("assistant", [assistant], text || null);

    if (!toolCalls.length || finish === "length") break;

    const results: ORMessage[] = await Promise.all(
      toolCalls.map(async (tc) => {
        cb.onTool({ name: tc.function.name, status: "start" });
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments); } catch { input = { __invalid_json: tc.function.arguments }; }
        const r = await runChatTool(tc.function.name, input, ctx);
        cb.onTool({ name: tc.function.name, label: r.label, status: r.ok ? "done" : "error" });
        return { role: "tool" as const, tool_call_id: tc.id, content: r.ok ? r.content : `ERROR: ${r.content}` };
      }),
    );
    messages.push(...results);
    await cb.persist("user", results, null);
  }
}

/** Rebuilds OpenRouter history from stored rows (skips rows from another provider). */
export function toOpenRouterHistory(rows: { role: string; content: unknown; display_text: string | null }[]): ORMessage[] {
  const out: ORMessage[] = [];
  for (const r of rows) {
    const c = r.content as { provider?: string; messages?: ORMessage[] } | unknown[];
    if (!Array.isArray(c) && c && typeof c === "object" && (c as { provider?: string }).provider === "openrouter") {
      out.push(...((c as { messages: ORMessage[] }).messages ?? []));
    } else if (r.display_text) {
      // plain text from an earlier provider — keep the words, drop provider-specific blocks
      out.push({ role: r.role === "assistant" ? "assistant" : "user", content: r.display_text });
    }
  }
  return out;
}
