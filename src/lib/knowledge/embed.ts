import { serverEnv } from "@/lib/env";

// Optional embeddings via Voyage AI (Anthropic's recommended embeddings
// partner). Without VOYAGE_API_KEY, knowledge search uses Postgres
// full-text search only, which works fine for most knowledge bases.

const MODEL = "voyage-3.5";

export function embeddingsEnabled(): boolean {
  return Boolean(serverEnv.voyageApiKey());
}

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][] | null> {
  const key = serverEnv.voyageApiKey();
  if (!key || texts.length === 0) return null;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input: texts.slice(i, i + 64), input_type: inputType, output_dimension: 1024 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data: { embedding: number[] }[] };
    out.push(...body.data.map((d) => d.embedding));
  }
  return out;
}

export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
