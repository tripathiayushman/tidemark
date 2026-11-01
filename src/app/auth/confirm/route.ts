import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { friendlyAuthError } from "@/lib/auth-errors";

// Server-verified email links (token_hash flow). Unlike the PKCE code flow,
// this works even when the link is opened in a different browser or device,
// because nothing has to be stored in the requesting browser.
//
// Point the Supabase "Magic Link" and "Confirm signup" email templates at:
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/home
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = (url.searchParams.get("type") ?? "email") as EmailOtpType;
  const nextParam = url.searchParams.get("next");
  const next = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/home";

  if (tokenHash) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(friendlyAuthError(error.message))}`, url.origin));
  }
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent("That sign-in link is incomplete. Request a new one.")}`, url.origin));
}

