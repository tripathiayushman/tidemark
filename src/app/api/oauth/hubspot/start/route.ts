import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/auth";
import { publicEnv, serverEnv } from "@/lib/env";
import { makeOAuthState } from "@/lib/integrations/connections";
import { hubspotAuthorizeUrl } from "@/lib/integrations/crm/hubspot";

// GET /api/oauth/hubspot/start — sends the signed-in member to HubSpot's consent screen.

function appRedirect(path: string) {
  return NextResponse.redirect(new URL(path, publicEnv.appUrl()));
}

export async function GET() {
  const ctx = await getWorkspaceContext();
  if (!ctx) return appRedirect("/login");
  if (!serverEnv.hubspotClientId() || !serverEnv.hubspotClientSecret()) {
    return appRedirect(`/settings/integrations?error=${encodeURIComponent("HubSpot isn't configured on this server yet.")}`);
  }
  const state = makeOAuthState({ workspaceId: ctx.workspace.id, userId: ctx.user.id, provider: "hubspot" });
  return NextResponse.redirect(hubspotAuthorizeUrl(state));
}
