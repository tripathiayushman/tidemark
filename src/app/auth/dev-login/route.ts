import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { devLoginEmail, devLoginEnabled } from "@/lib/dev-login";

// DEV ONLY: one-click sign-in for local testing, no email round trip.
// Generates a one-time magic-link token server-side (service role) and
// verifies it immediately with the cookie-bound client, which sets the
// normal Supabase session cookies. Disabled unless NODE_ENV is not
// "production" AND DEV_LOGIN_ENABLED=true; otherwise this route 404s.
export async function POST(request: NextRequest) {
  if (!devLoginEnabled()) return new NextResponse("Not found", { status: 404 });
  const origin = request.nextUrl.origin;
  const email = devLoginEmail();

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(`Dev login failed: ${error?.message ?? "no token"}`)}`, origin), { status: 303 });
  }

  const supabase = await createClient();
  const { error: vErr } = await supabase.auth.verifyOtp({ type: "email", token_hash: data.properties.hashed_token });
  if (vErr) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(`Dev login failed: ${vErr.message}`)}`, origin), { status: 303 });
  }
  return NextResponse.redirect(new URL("/home", origin), { status: 303 });
}
