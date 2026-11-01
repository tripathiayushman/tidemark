import { requireWorkspace } from "@/lib/auth";
import { AppSidebar } from "@/components/tm/app-sidebar";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await requireWorkspace();
  return (
    <div className="flex min-h-screen">
      <AppSidebar
        workspace={{ id: ctx.workspace.id, name: ctx.workspace.name }}
        memberships={ctx.memberships}
        user={{ name: ctx.user.fullName ?? ctx.user.email ?? "You", email: ctx.user.email }}
      />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
