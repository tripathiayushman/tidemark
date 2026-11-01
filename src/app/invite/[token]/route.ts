import { NextResponse, type NextRequest } from "next/server";
import { ACTIVE_WS_COOKIE } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// Accepts a workspace invite for the signed-in user, then lands them in the app.
export async function GET(request: NextRequest, ctx: RouteContext<"/invite/[token]">) {
  const { token } = await ctx.params;
  const origin = request.nextUrl.origin;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(`/invite/${token}`)}`, origin));

  const { data, error } = await supabase.rpc("accept_workspace_invite", { p_token: token });
  if (error || !data) {
    const msg = `${error?.message ?? "Invite not found"} (signed in as ${auth.user.email})`;
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, origin));
  }
  const res = NextResponse.redirect(new URL("/home", origin));
  res.cookies.set(ACTIVE_WS_COOKIE, data as string, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  return res;
}
