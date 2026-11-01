"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inviteMember } from "@/app/actions/workspace";

export function InviteForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap gap-2"
        action={(fd) => start(async () => {
          const r = await inviteMember(fd);
          if (r.error) toast.error(r.error);
          else { setLink(`${window.location.origin}/invite/${r.token}`); router.refresh(); }
        })}
      >
        <Input name="email" type="email" required placeholder="teammate@company.com" className="max-w-xs" />
        <select name="role" className="h-8 rounded-lg border bg-background px-2 text-sm"><option value="member">Member</option><option value="admin">Admin</option></select>
        <Button type="submit" disabled={pending}>Create invite</Button>
      </form>
      {link ? (
        <div className="flex items-center gap-2 rounded-lg border bg-accent/40 px-3 py-2 text-sm">
          <span className="truncate">{link}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Copy invite link" onClick={() => { navigator.clipboard.writeText(link); toast.success("Copied"); }}><Copy /></Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">Share the link with your teammate. They sign in with the invited email to join.</p>
    </div>
  );
}
