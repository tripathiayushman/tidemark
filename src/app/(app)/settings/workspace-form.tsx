"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateWorkspace } from "@/app/actions/workspace";

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

export function WorkspaceForm({ name, website, timezone, disabled }: { name: string; website: string; timezone: string; disabled: boolean }) {
  const [pending, start] = useTransition();
  return (
    <form className="space-y-4" action={(fd) => start(async () => { const r = await updateWorkspace(fd); if (r.error) toast.error(r.error); else toast.success("Saved"); })}>
      <div className="space-y-1.5"><Label htmlFor="name">Name</Label><Input id="name" name="name" defaultValue={name} disabled={disabled} /></div>
      <div className="space-y-1.5"><Label htmlFor="website">Website</Label><Input id="website" name="website" defaultValue={website} disabled={disabled} /></div>
      <div className="space-y-1.5">
        <Label htmlFor="timezone">Timezone (sending hours, task dates)</Label>
        <select id="timezone" name="timezone" defaultValue={timezone} disabled={disabled} className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
          {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </div>
      {!disabled ? <Button type="submit" disabled={pending}>Save</Button> : <p className="text-xs text-muted-foreground">Only admins can change workspace settings.</p>}
    </form>
  );
}
