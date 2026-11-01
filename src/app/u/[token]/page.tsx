import type { Metadata } from "next";
import { verifyToken } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

// Public unsubscribe confirmation. Opening the link never unsubscribes by
// itself (mail scanners prefetch links); the button POSTs to /api/unsubscribe.

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
};

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(1, Math.min(6, local.length - visible.length)))}@${domain}`;
}

async function senderName(workspaceId: string): Promise<string | null> {
  try {
    const { data } = await createAdminClient().from("workspaces").select("name").eq("id", workspaceId).maybeSingle();
    return (data?.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const data = verifyToken<{ ws: string; email: string }>(token);
  const valid = Boolean(data && typeof data.ws === "string" && typeof data.email === "string");
  const sender = valid ? await senderName(data!.ws) : null;
  const done = query.done === "1";
  const error = typeof query.error === "string" ? query.error : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16 text-foreground">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
        {!valid || error === "invalid" ? (
          <>
            <h1 className="text-lg font-semibold">This link is invalid or has expired</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Reply to the email you received and ask to be removed — the sender will take you off their list.
            </p>
          </>
        ) : done ? (
          <>
            <h1 className="text-lg font-semibold">You&apos;re unsubscribed</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {maskEmail(data!.email)} won&apos;t receive any more emails{sender ? ` from ${sender}` : ""}. You can close this page.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">Unsubscribe from these emails?</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Stop all further emails{sender ? ` from ${sender}` : ""} to {maskEmail(data!.email)}.
            </p>
            {error === "failed" && (
              <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Something went wrong. Please try again.
              </p>
            )}
            <form method="post" action={`/api/unsubscribe?token=${encodeURIComponent(token)}`} className="mt-6">
              <input type="hidden" name="source" value="page" />
              <button
                type="submit"
                className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Unsubscribe
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
