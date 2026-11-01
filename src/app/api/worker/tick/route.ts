import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/crypto";
import { tick } from "@/lib/worker/runner";

// Drains the job queue for ~50s per call. Trigger every minute from
// Supabase pg_cron + pg_net (see supabase/cron.sql), Vercel Cron, or any
// scheduler, with `Authorization: Bearer $CRON_SECRET`.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await tick({ budgetMs: 50_000 });
  return NextResponse.json({ ok: true, scheduled: result.scheduled.length, ran: result.ran });
}

// Vercel Cron issues GET requests.
export const GET = POST;
