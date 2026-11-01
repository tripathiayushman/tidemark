"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  ["/settings", "Workspace"],
  ["/settings/icp", "ICP & segments"],
  ["/settings/integrations", "Integrations"],
  ["/settings/network", "Network"],
  ["/settings/sources", "Data sources"],
  ["/settings/team", "Team"],
] as const;

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
      {ITEMS.map(([href, label]) => (
        <Link key={href} href={href} className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-sm", path === href ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
