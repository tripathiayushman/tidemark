import type { Metadata } from "next";
import { LoginForm } from "./login-form";
import { Logo } from "@/components/tm/logo";
import { devLoginEmail, devLoginEnabled } from "@/lib/dev-login";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") ? sp.next : "/home";
  const error = typeof sp.error === "string" ? sp.error : null;
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <div className="flex flex-col justify-between p-8 sm:p-12">
        <Logo />
        <div className="mx-auto w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to Tidemark</h1>
          <p className="mt-2 text-sm text-muted-foreground">We&apos;ll email you a magic link. No password needed.</p>
          <LoginForm next={next} initialError={error} />
          {devLoginEnabled() ? (
            <form action="/auth/dev-login" method="post" className="mt-6 rounded-lg border border-dashed border-signal/60 p-3">
              <p className="mb-2 text-xs text-muted-foreground">Development only — signs in as <span className="font-medium text-foreground">{devLoginEmail()}</span> without an email.</p>
              <button type="submit" className="w-full rounded-md bg-signal/20 px-3 py-2 text-sm font-medium text-signal-foreground hover:bg-signal/30">Dev login (test)</button>
            </form>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">By continuing you agree to use Tidemark for low-volume, relevant, consent-respecting outreach.</p>
      </div>
      <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:block">
        <div className="absolute inset-0 opacity-20 [background:repeating-linear-gradient(180deg,transparent_0_38px,currentColor_38px_39px)]" />
        <div className="relative flex h-full flex-col justify-end gap-6 p-12">
          <p className="max-w-md text-3xl font-semibold leading-tight tracking-tight">
            A loan funds. A permit closes out. Machines clear customs.
          </p>
          <p className="max-w-md text-primary-foreground/80">
            Tidemark reads dated public records in order and tells you which manufacturers have a real reason to buy — with the evidence, the timing and the people to reach.
          </p>
          <ol className="max-w-md space-y-2 text-sm">
            {[
              ["Money moving", "SBA 504 loan funded, $3.2M"],
              ["Building", "Permit closed out on a 64,000 sq ft addition"],
              ["Equipment", "Inbound shipment, 14 containers — fiber laser"],
            ].map(([k, v]) => (
              <li key={k} className="flex items-center gap-3 rounded-lg bg-primary-foreground/10 px-3 py-2">
                <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-primary-foreground/70">{k}</span>
                <span>{v}</span>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </main>
  );
}
