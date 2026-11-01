import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceContext, isAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectInstantly } from "@/lib/integrations/outreach/instantly";
import { connectGranola } from "@/lib/integrations/outreach/granola";

// Connect an API-key integration for the active workspace.
//   Instantly: workspace admins only; registers the outcomes webhook.
//   Granola:   any member; read-only; queues the first meeting sync.
// The key is validated with a cheap read call, then stored encrypted in
// integration_secrets (never logged, never returned).

const Body = z.object({
  provider: z.enum(["instantly", "granola"]),
  apiKey: z.string().trim().min(8).max(512),
});

export async function POST(request: NextRequest) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ ok: false, error: "Sign in to connect integrations." }, { status: 401 });

  let parsed: z.infer<typeof Body>;
  try {
    const result = Body.safeParse(await request.json());
    if (!result.success) return NextResponse.json({ ok: false, error: "Expected {provider: 'instantly'|'granola', apiKey}." }, { status: 400 });
    parsed = result.data;
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be JSON." }, { status: 400 });
  }

  if (parsed.provider === "instantly" && !isAdmin(ctx.role)) {
    return NextResponse.json({ ok: false, error: "Only a workspace owner or admin can connect Instantly." }, { status: 403 });
  }

  const db = createAdminClient();
  try {
    const result =
      parsed.provider === "instantly"
        ? await connectInstantly(db, { workspaceId: ctx.workspace.id, userId: ctx.user.id, apiKey: parsed.apiKey })
        : await connectGranola(db, { workspaceId: ctx.workspace.id, userId: ctx.user.id, userEmail: ctx.user.email, apiKey: parsed.apiKey });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    console.error(`[connect ${parsed.provider}] ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: "Could not save the connection. Try again." }, { status: 500 });
  }
}
