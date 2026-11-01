import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceContext } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { getSecret, readOAuthState, saveConnection, type StoredSecret } from "@/lib/integrations/connections";
import { GMAIL_READ_SCOPE, exchangeCode, getProfile } from "@/lib/integrations/gmail/client";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/oauth/gmail/callback?code&state — Google redirects here after consent.

function back(query: string) {
  return NextResponse.redirect(new URL(`/settings/integrations?${query}`, publicEnv.appUrl()));
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = readOAuthState(params.get("state"), "gmail");
  if (!state) return back("error=gmail_invalid_state");

  // The browser finishing the flow must be the member who started it, still in that
  // workspace — otherwise someone could attach their mailbox to another person's workspace.
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.redirect(new URL("/login", publicEnv.appUrl()));
  if (ctx.user.id !== state.userId || !ctx.memberships.some((m) => m.id === state.workspaceId)) {
    return back("error=gmail_session_mismatch");
  }

  const oauthError = params.get("error");
  if (oauthError) return back(`error=${encodeURIComponent(oauthError === "access_denied" ? "gmail_access_denied" : "gmail_oauth_error")}`);
  const code = params.get("code");
  if (!code) return back("error=gmail_missing_code");

  let failure: string | null = null;
  try {
    const token = await exchangeCode(code);
    const scopes = (token.scope ?? "").split(/\s+/).filter(Boolean);
    // Google's consent screen lets people untick scopes; without read access there is nothing to sync.
    if (!scopes.includes(GMAIL_READ_SCOPE)) {
      failure = "gmail_read_scope_missing";
    } else {
      const profile = await getProfile(token.access_token);
      const email = profile.emailAddress.trim().toLowerCase();

      const db = createAdminClient();
      const { data: existing } = await db
        .from("integration_connections")
        .select("id, settings")
        .eq("workspace_id", state.workspaceId)
        .eq("provider", "gmail")
        .eq("external_account_id", email)
        .maybeSingle();

      // Google may omit refresh_token on re-consent; keep the stored one.
      let refreshToken = token.refresh_token;
      if (!refreshToken && existing) {
        try {
          refreshToken = (await getSecret(db, existing.id as string)).refresh_token;
        } catch {
          // no stored secret
        }
      }
      const secret: StoredSecret = {
        access_token: token.access_token,
        refresh_token: refreshToken,
        expires_at: token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : undefined,
      };

      const conn = await saveConnection(db, {
        workspaceId: state.workspaceId,
        provider: "gmail",
        externalAccountId: email,
        accountLabel: email,
        scopes,
        // Sending stays off until the member switches it on.
        settings: { sending_enabled: false, prospect_scope: "qualified", ...((existing?.settings as Record<string, unknown> | null) ?? {}) },
        connectedBy: state.userId,
        secret,
      });
      await enqueue("gmail.sync", { connectionId: conn.id }, { workspaceId: state.workspaceId, dedupeKey: `gmail.sync:${conn.id}`, priority: 60 });
    }
  } catch (e) {
    console.error(`[oauth/gmail] connect failed: ${(e as Error).message}`);
    failure = "gmail_connect_failed";
  }
  if (failure) return back(`error=${failure}`);
  return back("connected=gmail");
}
