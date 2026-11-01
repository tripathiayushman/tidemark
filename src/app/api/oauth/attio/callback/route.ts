import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceContext } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { readOAuthState, saveConnection } from "@/lib/integrations/connections";
import { attioIdentify, exchangeAttioCode } from "@/lib/integrations/crm/attio";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/oauth/attio/callback?code&state — Attio redirects here after consent.

function back(query: Record<string, string>) {
  return NextResponse.redirect(new URL(`/settings/integrations?${new URLSearchParams(query)}`, publicEnv.appUrl()));
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = readOAuthState(params.get("state"), "attio");
  if (!state) return back({ error: "The Attio sign-in link expired. Try connecting again." });

  // The browser finishing the flow must be the member who started it, still in that workspace.
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.redirect(new URL("/login", publicEnv.appUrl()));
  if (ctx.user.id !== state.userId || !ctx.memberships.some((m) => m.id === state.workspaceId)) {
    return back({ error: "Finish connecting Attio from the account that started it." });
  }

  const oauthError = params.get("error");
  if (oauthError) return back({ error: params.get("error_description") ?? "Attio access was not granted." });
  const code = params.get("code");
  if (!code) return back({ error: "Attio didn't return an authorization code." });

  try {
    const token = await exchangeAttioCode(code);
    const self = await attioIdentify(token.access_token);
    if (!self.active || !self.workspace_id) throw new Error("Attio reports the new token as inactive");

    const db = createAdminClient();
    const { data: existing } = await db
      .from("integration_connections")
      .select("settings")
      .eq("workspace_id", state.workspaceId)
      .eq("provider", "attio")
      .eq("external_account_id", self.workspace_id)
      .maybeSingle();

    const conn = await saveConnection(db, {
      workspaceId: state.workspaceId,
      provider: "attio",
      externalAccountId: self.workspace_id,
      accountLabel: self.workspace_name ?? self.workspace_slug ?? "Attio workspace",
      scopes: (self.scope ?? "").split(/\s+/).filter(Boolean),
      settings: (existing?.settings as Record<string, unknown> | null) ?? {},
      connectedBy: state.userId,
      secret: {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : undefined,
      },
    });

    try {
      await enqueue("crm.push", { connectionId: conn.id }, { workspaceId: state.workspaceId, dedupeKey: `crm.push:${conn.id}`, priority: 60 });
    } catch (e) {
      // The 15-minute crm.pull schedule pushes too, so this isn't fatal.
      console.error(`[oauth/attio] enqueue first push failed: ${(e as Error).message}`);
    }
    return back({ connected: "attio" });
  } catch (e) {
    console.error(`[oauth/attio] callback failed: ${(e as Error).message}`);
    return back({ error: "Couldn't finish connecting Attio. Please try again." });
  }
}
