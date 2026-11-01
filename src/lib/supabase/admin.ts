import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/lib/env";

let cached: SupabaseClient | null = null;

/**
 * Service-role client: bypasses RLS. Use only in the worker, webhooks, OAuth
 * callbacks and server code that has already authorized the caller. Never
 * import this from a client component.
 */
export function createAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("createAdminClient must not run in the browser");
  }
  cached ??= createClient(publicEnv.supabaseUrl(), serverEnv.supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
