import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { serverEnv } from "@/lib/env";

// One place for model choice and request defaults.
//   * Model: claude-opus-5-5 unless ANTHROPIC_MODEL overrides it.
//   * Refusals: server-side fallbacks ("default" routing) are on, so a
//     classifier decline is retried on Anthropic's recommended model inside
//     the same call. We still check stop_reason before reading content.
//   * Effort is set per call site: research reasoning = high, extraction =
//     medium, short drafting = low.

export const FALLBACK_BETA = "server-side-fallback-2026-07-01" as const;

let client: Anthropic | null = null;
export function claude(): Anthropic {
  // Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) from the env.
  client ??= new Anthropic();
  return client;
}

export function model(): string {
  return serverEnv.anthropicModel();
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class ClaudeOutputError extends Error {
  constructor(
    message: string,
    readonly stopReason: string | null,
  ) {
    super(message);
    this.name = "ClaudeOutputError";
  }
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  usage: Anthropic.Beta.BetaUsage;
}

/**
 * Single structured-output call validated against a Zod schema.
 * Throws ClaudeOutputError on refusal / truncation / unparsable output.
 */
export async function generateStructured<S extends z.ZodType>(opts: {
  system: string;
  prompt: string | Anthropic.Beta.BetaContentBlockParam[];
  schema: S;
  effort?: Effort;
  maxTokens?: number;
  cacheSystem?: boolean;
}): Promise<StructuredResult<z.infer<S>>> {
  const response = await claude().beta.messages.parse({
    model: model(),
    max_tokens: opts.maxTokens ?? 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
    system: opts.cacheSystem
      ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
      : opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new ClaudeOutputError(
      `Model declined the request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`,
      response.stop_reason,
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new ClaudeOutputError("Output truncated at max_tokens", response.stop_reason);
  }
  if (response.parsed_output == null) {
    throw new ClaudeOutputError("Structured output did not match the schema", response.stop_reason);
  }
  return { data: response.parsed_output as z.infer<S>, model: response.model, usage: response.usage };
}

/** Plain text completion (short drafting tasks). */
export async function generateText(opts: {
  system: string;
  prompt: string;
  effort?: Effort;
  maxTokens?: number;
}): Promise<string> {
  const response = await claude().beta.messages.create({
    model: model(),
    max_tokens: opts.maxTokens ?? 8000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "low" },
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });
  if (response.stop_reason === "refusal") {
    throw new ClaudeOutputError("Model declined the request", response.stop_reason);
  }
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Retryable = rate limits, overload, 5xx, network. */
export function isRetryableClaudeError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 500) return true;
  return false;
}
