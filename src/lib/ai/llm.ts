import { z } from "zod";
import { publicEnv, serverEnv } from "@/lib/env";
import * as anthropic from "./claude";

// Provider-neutral LLM calls used by the whole pipeline.
//   LLM_PROVIDER=openrouter (default when OPENROUTER_API_KEY is set) → OpenRouter
//   LLM_PROVIDER=anthropic                                          → Claude
//
// OpenRouter: OpenAI-compatible chat completions. Structured outputs use
// response_format json_schema (strict) when the model supports it; otherwise
// the schema goes in the prompt. Either way the result is validated with Zod
// and repaired once on failure.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Task = "research" | "default";

export class LlmRateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "LlmRateLimitError";
  }
}

export class LlmOutputError extends Error {
  constructor(message: string, readonly finishReason: string | null = null) {
    super(message);
    this.name = "LlmOutputError";
  }
}

export interface StructuredResult<T> {
  data: T;
  model: string;
}

export function currentModel(task: Task = "default"): string {
  if (serverEnv.llmProvider() === "anthropic") return serverEnv.anthropicModel();
  return (task === "research" ? serverEnv.openrouterResearchModel() : undefined) ?? serverEnv.openrouterModel();
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export function openrouterHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${serverEnv.openrouterApiKey()}`,
    "Content-Type": "application/json",
    "HTTP-Referer": publicEnv.appUrl(),
    "X-Title": "Tidemark",
  };
}

/** Maps our effort levels onto OpenRouter's unified reasoning parameter. */
export function reasoningFor(effort: Effort | undefined) {
  const e = effort === "xhigh" || effort === "max" ? "high" : effort ?? "medium";
  return { effort: e };
}

/** Throws typed errors for rate limits / credit / provider failures. */
export async function raiseForOpenRouter(res: Response): Promise<never> {
  const text = await res.text();
  let msg = text.slice(0, 400);
  try {
    const j = JSON.parse(text) as { error?: { message?: string; metadata?: { raw?: string } } };
    msg = j.error?.message ?? msg;
  } catch { /* keep raw text */ }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const ms = retryAfter > 0 ? retryAfter * 1000 : reset > Date.now() ? reset - Date.now() : /day/i.test(msg) ? 60 * 60_000 : 60_000;
    throw new LlmRateLimitError(`OpenRouter rate limit: ${msg}`, Math.min(ms, 6 * 60 * 60_000));
  }
  if (res.status === 402) throw new Error(`OpenRouter: insufficient credits — ${msg}`);
  if (res.status === 401) throw new Error(`OpenRouter: API key rejected (OPENROUTER_API_KEY) — ${msg}`);
  throw new Error(`OpenRouter ${res.status}: ${msg}`);
}

interface ORChoice {
  message?: { content?: string | null; reasoning?: string | null };
  finish_reason?: string | null;
}

async function openrouterComplete(body: Record<string, unknown>): Promise<{ text: string; model: string; finish: string | null }> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: openrouterHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) await raiseForOpenRouter(res);
  const j = (await res.json()) as { choices?: ORChoice[]; model?: string; error?: { message?: string; code?: number } };
  if (j.error) {
    if (j.error.code === 429) throw new LlmRateLimitError(`OpenRouter rate limit: ${j.error.message}`, 60_000);
    throw new Error(`OpenRouter error: ${j.error.message ?? "unknown"}`);
  }
  const choice = j.choices?.[0];
  return { text: choice?.message?.content ?? "", model: j.model ?? String(body.model), finish: choice?.finish_reason ?? null };
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[[{]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new LlmOutputError("Model did not return JSON");
  }
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

const unsupportedStructured = new Set<string>(); // models that rejected response_format this process

export async function generateStructured<S extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: S;
  effort?: Effort;
  maxTokens?: number;
  cacheSystem?: boolean;
  task?: Task;
}): Promise<StructuredResult<z.infer<S>>> {
  if (serverEnv.llmProvider() === "anthropic") {
    const r = await anthropic.generateStructured(opts);
    return { data: r.data, model: r.model };
  }

  const model = currentModel(opts.task);
  const schemaJson = jsonSchemaFor(opts.schema);
  const useNative = !unsupportedStructured.has(model);
  const system = useNative
    ? opts.system
    : `${opts.system}\n\nRespond with ONLY a JSON object (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(schemaJson)}`;
  const messages: { role: string; content: string }[] = [
    { role: "system", content: system },
    { role: "user", content: opts.prompt },
  ];
  const base: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 16000,
    reasoning: reasoningFor(opts.effort),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let out: Awaited<ReturnType<typeof openrouterComplete>>;
    try {
      out = await openrouterComplete({
        ...base,
        messages,
        ...(useNative && !unsupportedStructured.has(model)
          ? { response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema: schemaJson } } }
          : {}),
      });
    } catch (e) {
      // Model/provider without structured-output support → retry with the schema in the prompt.
      if (!(e instanceof LlmRateLimitError) && /response_format|structured|json_schema|not support/i.test((e as Error).message) && !unsupportedStructured.has(model)) {
        unsupportedStructured.add(model);
        return generateStructured(opts);
      }
      throw e;
    }
    if (out.finish === "length") throw new LlmOutputError("Output truncated at max_tokens", out.finish);
    let parsed: unknown;
    try {
      parsed = extractJson(out.text);
    } catch (e) {
      if (attempt === 0) {
        messages.push({ role: "assistant", content: out.text.slice(0, 4000) }, { role: "user", content: "That was not valid JSON. Reply again with ONLY the JSON object." });
        continue;
      }
      throw e;
    }
    const v = opts.schema.safeParse(parsed);
    if (v.success) return { data: v.data as z.infer<S>, model: out.model };
    if (attempt === 0) {
      messages.push(
        { role: "assistant", content: out.text.slice(0, 4000) },
        { role: "user", content: `The JSON did not match the schema: ${v.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Reply again with ONLY the corrected JSON object.` },
      );
      continue;
    }
    throw new LlmOutputError(`Structured output did not match the schema: ${v.error.issues[0]?.message ?? "invalid"}`);
  }
  throw new LlmOutputError("Structured output failed");
}

export async function generateText(opts: { system: string; prompt: string; effort?: Effort; maxTokens?: number; task?: Task }): Promise<string> {
  if (serverEnv.llmProvider() === "anthropic") return anthropic.generateText(opts);
  const out = await openrouterComplete({
    model: currentModel(opts.task),
    max_tokens: opts.maxTokens ?? 8000,
    reasoning: reasoningFor(opts.effort ?? "low"),
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.prompt },
    ],
  });
  return out.text.trim();
}
