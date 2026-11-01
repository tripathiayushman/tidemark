import Link from "next/link";
import { cn } from "@/lib/utils";

/** Tidemark mark: a water line with a rising marker. */
export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <Link href="/home" className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <svg viewBox="0 0 24 24" className="size-6 text-tide" aria-hidden>
        <rect x="1" y="1" width="22" height="22" rx="6" className="fill-primary" />
        <path d="M5 15.5c2 0 2-1.5 4-1.5s2 1.5 4 1.5 2-1.5 4-1.5 2 1.5 2 1.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M12 6v6M9.5 8.5 12 6l2.5 2.5" fill="none" className="stroke-signal" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {compact ? null : <span>Tidemark</span>}
    </Link>
  );
}
