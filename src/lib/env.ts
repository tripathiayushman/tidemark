// Central env access. Server-only values throw a clear error when missing so
// a misconfigured deploy fails loudly at the call site instead of deep inside
// an SDK. (No "server-only" import: the worker runs this outside Next.)

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const publicEnv = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabasePublishableKey: () => required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  appUrl: () => optional("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3000",
};

export const serverEnv = {
  supabaseSecretKey: () => required("SUPABASE_SECRET_KEY"),
  /** 32-byte key, base64. Encrypts OAuth tokens + API keys at rest. */
  encryptionKey: () => required("TIDEMARK_ENCRYPTION_KEY"),
  /** Shared secret for /api/worker/* and signed links. */
  cronSecret: () => required("CRON_SECRET"),
  /** "openrouter" (default when OPENROUTER_API_KEY is set) or "anthropic". */
  llmProvider: (): "openrouter" | "anthropic" =>
    (optional("LLM_PROVIDER") as "openrouter" | "anthropic" | undefined) ??
    (optional("OPENROUTER_API_KEY") ? "openrouter" : "anthropic"),
  anthropicModel: () => optional("ANTHROPIC_MODEL") ?? "claude-opus-5-5",
  openrouterApiKey: () => required("OPENROUTER_API_KEY"),
  /** Default model for every task. Must support tools + structured outputs. */
  openrouterModel: () => optional("OPENROUTER_MODEL") ?? "nvidia/nemotron-3.5-super-vl:free",
  /** Optional stronger model for the research step only (falls back to OPENROUTER_MODEL). */
  openrouterResearchModel: () => optional("OPENROUTER_RESEARCH_MODEL"),
  voyageApiKey: () => optional("VOYAGE_API_KEY"),

  // Data / contact providers (all optional — features degrade gracefully)
  samApiKey: () => optional("SAM_GOV_API_KEY"),
  sba504CsvUrl: () => optional("SBA_504_CSV_URL"),
  sba7aCsvUrl: () => optional("SBA_7A_CSV_URL"),
  apolloApiKey: () => optional("APOLLO_API_KEY"),
  pdlApiKey: () => optional("PDL_API_KEY"),
  hunterApiKey: () => optional("HUNTER_API_KEY"),
  zeroBounceApiKey: () => optional("ZEROBOUNCE_API_KEY"),

  // OAuth apps
  googleClientId: () => optional("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => optional("GOOGLE_CLIENT_SECRET"),
  hubspotClientId: () => optional("HUBSPOT_CLIENT_ID"),
  hubspotClientSecret: () => optional("HUBSPOT_CLIENT_SECRET"),
  attioClientId: () => optional("ATTIO_CLIENT_ID"),
  attioClientSecret: () => optional("ATTIO_CLIENT_SECRET"),
  granolaApiBase: () => optional("GRANOLA_API_BASE") ?? "https://public-api.granola.ai/v1",
};

export const optionalEnv = optional;
