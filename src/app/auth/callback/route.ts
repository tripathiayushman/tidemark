import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { friendlyAuthError } from "@/lib/auth-errors";

// Magic-link / OAuth return (PKCE code flow): exchange the code for a session
// cookie. Requires the link to open in the same browser that requested it;
// /auth/confirm (token_hash) is the cross-browser alternative.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const nextParam = url.searchParams.get("next");
  const next = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/home";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(friendlyAuthError(error.message))}`, url.origin));
  }
  const err = url.searchParams.get("error_description") ?? "Sign-in link is invalid or expired";
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(friendlyAuthError(err))}`, url.origin));
}
