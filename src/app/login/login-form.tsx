"use client";

import { useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ next, initialError }: { next: string; initialError: string | null }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(initialError);

  const redirectTo = () => `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState("sending");
    const { error } = await createClient().auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo() } });
    if (error) {
      setError(error.message);
      setState("idle");
    } else setState("sent");
  }

  async function google() {
    setError(null);
    const { error } = await createClient().auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) setError(error.message);
  }

  if (state === "sent") {
    return (
      <div className="mt-8 rounded-lg border bg-card p-5">
        <Mail className="mb-2 size-5 text-tide" />
        <p className="font-medium">Check your inbox</p>
        <p className="mt-1 text-sm text-muted-foreground">We sent a sign-in link to {email}. It expires in an hour.</p>
        <Button variant="link" className="mt-2 px-0" onClick={() => setState("idle")}>Use a different email</Button>
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-4">
      <form onSubmit={sendLink} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="email">Work email</Label>
          <Input id="email" type="email" required autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <Button type="submit" className="w-full" size="lg" disabled={state === "sending"}>
          {state === "sending" ? <Loader2 className="animate-spin" /> : null}
          Email me a sign-in link
        </Button>
      </form>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
      </div>
      <Button variant="outline" size="lg" className="w-full" onClick={google}>
        Continue with Google
      </Button>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
