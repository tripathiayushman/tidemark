"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { archiveIcp, setPrimaryIcp } from "@/app/actions/icp";

export function IcpListActions({ id, isPrimary }: { id: string; isPrimary: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="ml-auto flex gap-1">
      {!isPrimary ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(async () => { await setPrimaryIcp(id); router.refresh(); })}>Make primary</Button> : null}
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(async () => { await archiveIcp(id); router.push("/settings/icp"); })}>Archive</Button>
    </div>
  );
}
