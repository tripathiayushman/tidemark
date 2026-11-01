import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/auth";
import { publicEnv, serverEnv } from "@/lib/env";
import { makeOAuthState } from "@/lib/integrations/connections";
import { attioAuthorizeUrl } from "@/lib/integrations/crm/attio";

// GET /api/oauth/attio/start — sends the signed-in member to Attio's consent screen.

function appRedirect(path: string) {
  return NextResponse.redirect(new URL(path, publicEnv.appUrl()));
}

export async function GET() {
  const ctx = await getWorkspaceContext();
  if (!ctx) return appRedirect("/login");
  if (!serverEnv.attioClientId() || !serverEnv.attioClientSecret()) {
    return appRedirect(`/settings/integrations?error=${encodeURIComponent("Attio isn't configured on this server yet.")}`);
  }
  const state = makeOAuthState({ workspaceId: ctx.workspace.id, userId: ctx.user.id, provider: "attio" });
  return NextResponse.redirect(attioAuthorizeUrl(state));
}
