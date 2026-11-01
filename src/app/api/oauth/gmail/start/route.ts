import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceContext } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { makeOAuthState } from "@/lib/integrations/connections";
import { googleAuthUrl, googleOAuthConfigured } from "@/lib/integrations/gmail/client";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/oauth/gmail/start[?sending=1]
// Connects the signed-in member's own mailbox (read-only). `sending=1` asks
// for gmail.send on top of what was already granted (incremental consent).

function appRedirect(path: string) {
  return NextResponse.redirect(new URL(path, publicEnv.appUrl()));
}

export async function GET(request: NextRequest) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return appRedirect("/login");
  if (!googleOAuthConfigured()) return appRedirect("/settings/integrations?error=gmail_not_configured");

  const sending = request.nextUrl.searchParams.get("sending") === "1";

  // Pre-select the mailbox this member already connected (if exactly one) when adding sending.
  let loginHint: string | null = null;
  if (sending) {
    const { data } = await createAdminClient()
      .from("integration_connections")
      .select("external_account_id")
      .eq("workspace_id", ctx.workspace.id)
      .eq("provider", "gmail")
      .eq("connected_by", ctx.user.id)
      .limit(2);
    if (data?.length === 1) loginHint = (data[0].external_account_id as string) || null;
  }

  const state = makeOAuthState({
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    provider: "gmail",
    extra: { sending: sending ? 1 : 0 },
  });
  return NextResponse.redirect(googleAuthUrl({ state, sending, loginHint }));
}
