"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the server page every few seconds while background work runs. */
export function AutoRefresh({ active, intervalMs = 6000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}
