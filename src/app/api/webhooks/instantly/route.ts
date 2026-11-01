import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleInstantlyWebhook, readInstantlyWebhookToken, type WebhookResult } from "@/lib/integrations/outreach/instantly";

// Instantly → Tidemark outcomes (replies, bounces, unsubscribes, opens, clicks).
// Public route (see src/proxy.ts); authenticated by the HMAC-signed `?t=`
// token minted for this connection when the webhook was registered. Instantly
// documents no delivery signature, so the token is the only credential.
// Processing is idempotent, so redeliveries are safe.

const MAX_EVENTS = 100;

export async function POST(request: NextRequest) {
  const connectionId = readInstantlyWebhookToken(request.nextUrl.searchParams.get("t"));
  if (!connectionId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const events = Array.isArray(body) ? body : [body];
  if (events.length > MAX_EVENTS) return NextResponse.json({ ok: false, error: "too many events" }, { status: 413 });

  const db = createAdminClient();
  try {
    const results: WebhookResult[] = [];
    for (const ev of events) results.push(await handleInstantlyWebhook(db, connectionId, ev));
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    // Message only: payloads carry prospect PII.
    console.error(`[instantly webhook] ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: "processing failed" }, { status: 500 });
  }
}
