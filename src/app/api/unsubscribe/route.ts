import { NextResponse, type NextRequest } from "next/server";
import { verifyToken } from "@/lib/crypto";
import { publicEnv } from "@/lib/env";
import { stopEnrollments } from "@/lib/integrations/gmail/send";
import { createAdminClient } from "@/lib/supabase/admin";

// POST /api/unsubscribe?token=…
//   * RFC 8058 one-click: mail clients POST `List-Unsubscribe=One-Click` → 200
//   * the /u/<token> confirmation form posts `source=page` → 303 back to the page
// GET never unsubscribes (link scanners prefetch); it redirects to the confirmation page.
// Must be reachable without a session (see report: add to proxy PUBLIC_PATHS).

interface UnsubscribeToken extends Record<string, unknown> {
  ws: string;
  email: string;
}

function readToken(request: NextRequest): { raw: string; data: UnsubscribeToken } | null {
  const raw = request.nextUrl.searchParams.get("token");
  if (!raw) return null;
  const data = verifyToken<UnsubscribeToken>(raw);
  if (!data || typeof data.ws !== "string" || typeof data.email !== "string" || !data.email.includes("@")) return null;
  return { raw, data };
}

function pageUrl(token: string, query: string) {
  return new URL(`/u/${encodeURIComponent(token)}?${query}`, publicEnv.appUrl());
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("token");
  if (!raw) return new NextResponse("Missing token", { status: 400 });
  return NextResponse.redirect(pageUrl(raw, "from=link"), 303);
}

export async function POST(request: NextRequest) {
  let fromPage = false;
  try {
    const form = await request.formData();
    fromPage = form.get("source") === "page";
  } catch {
    // empty or non-form body: treat as a one-click request
  }

  const token = readToken(request);
  if (!token) {
    const raw = request.nextUrl.searchParams.get("token");
    if (fromPage && raw) return NextResponse.redirect(pageUrl(raw, "error=invalid"), 303);
    return new NextResponse("Invalid or expired unsubscribe link", { status: 400 });
  }

  try {
    await unsubscribe(token.data.ws, token.data.email.trim().toLowerCase(), fromPage ? "unsubscribe_page" : "one_click");
  } catch (e) {
    console.error(`[unsubscribe] failed: ${(e as Error).message}`);
    if (fromPage) return NextResponse.redirect(pageUrl(token.raw, "error=failed"), 303);
    return new NextResponse("Could not process the request, please try again", { status: 500 });
  }

  if (fromPage) return NextResponse.redirect(pageUrl(token.raw, "done=1"), 303);
  return new NextResponse("You have been unsubscribed.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function unsubscribe(workspaceId: string, email: string, source: string) {
  const db = createAdminClient();
  const now = new Date().toISOString();

  const { error: supError } = await db
    .from("suppressions")
    .upsert({ workspace_id: workspaceId, email, reason: "unsubscribe", source }, { onConflict: "workspace_id,email" });
  if (supError) throw new Error(`suppression: ${supError.message}`);

  // contacts.email is citext, so this matches regardless of case.
  const { data: contacts, error: cError } = await db.from("contacts").select("id, account_id, full_name, unsubscribed_at").eq("workspace_id", workspaceId).eq("email", email);
  if (cError) throw new Error(`contacts: ${cError.message}`);
  const rows = (contacts ?? []) as { id: string; account_id: string | null; full_name: string; unsubscribed_at: string | null }[];
  const fresh = rows.filter((c) => !c.unsubscribed_at);
  if (fresh.length) {
    await db.from("contacts").update({ unsubscribed_at: now }).in("id", fresh.map((c) => c.id)).is("unsubscribed_at", null);
  }

  if (rows.length) {
    const { data: enrollments } = await db
      .from("campaign_enrollments")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("contact_id", rows.map((c) => c.id))
      .eq("status", "active");
    await stopEnrollments(db, (enrollments ?? []).map((r) => r.id as string), "stopped_unsubscribe", "unsubscribe");
  }

  for (const c of fresh) {
    await db.from("activities").insert({
      workspace_id: workspaceId,
      account_id: c.account_id,
      contact_id: c.id,
      kind: "unsubscribed",
      title: `${c.full_name} unsubscribed`,
      data: { source },
      occurred_at: now,
    });
  }
}
