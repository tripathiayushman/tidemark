"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen, CheckSquare, ChevronsUpDown, Home, Lightbulb, LogOut, Megaphone, MessageSquare, Plus, Settings, Target, Moon, Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { switchWorkspace } from "@/app/actions/workspace";

const NAV = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/prospects", label: "Prospects", icon: Target },
  { href: "/insights", label: "Insights", icon: Lightbulb },
];
const NAV2 = [
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/chat", label: "Chat", icon: MessageSquare },
];

export function AppSidebar({
  workspace,
  memberships,
  user,
}: {
  workspace: { id: string; name: string };
  memberships: { id: string; name: string; role: string }[];
  user: { name: string; email: string | null };
}) {
  const path = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const item = (n: (typeof NAV)[number]) => {
    const active = path === n.href || path.startsWith(n.href + "/");
    return (
      <Link
        key={n.href}
        href={n.href}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
          active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        )}
      >
        <n.icon className="size-4" aria-hidden />
        {n.label}
      </Link>
    );
  };

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-14 items-center px-4">
        <Logo />
      </div>
      <div className="px-3">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center justify-between rounded-md border bg-background px-2.5 py-1.5 text-left text-sm hover:bg-muted">
            <span className="truncate font-medium">{workspace.name}</span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            {/* Base UI requires group labels to sit inside a Menu.Group */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {memberships.map((m) => (
                <DropdownMenuItem key={m.id} onClick={() => switchWorkspace(m.id)}>
                  <span className="truncate">{m.name}</span>
                  {m.id === workspace.id ? <span className="ml-auto text-xs text-muted-foreground">current</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/onboarding?new=1" />}>
              <Plus /> New workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <nav className="mt-4 flex flex-1 flex-col gap-0.5 px-3">
        {NAV.map(item)}
        <div className="my-3 h-px bg-sidebar-border" />
        {NAV2.map(item)}
        <div className="mt-auto" />
        {item({ href: "/settings", label: "Settings", icon: Settings })}
      </nav>
      <div className="border-t p-3">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent/60">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{user.name}</span>
              {user.email ? <span className="block truncate text-xs text-muted-foreground">{user.email}</span> : null}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" side="top">
            <DropdownMenuItem onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
              {resolvedTheme === "dark" ? <Sun /> : <Moon />} {resolvedTheme === "dark" ? "Light mode" : "Dark mode"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <form action="/auth/signout" method="post">
              <DropdownMenuItem render={<button type="submit" className="w-full" />}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
