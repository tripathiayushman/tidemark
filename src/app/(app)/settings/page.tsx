import type { Metadata } from "next";
import { requireWorkspace, isAdmin } from "@/lib/auth";
import { WorkspaceForm } from "./workspace-form";

export const metadata: Metadata = { title: "Settings" };

export default async function WorkspaceSettings() {
  const ctx = await requireWorkspace();
  return (
    <div className="max-w-xl space-y-4">
      <h2 className="font-semibold">Workspace</h2>
      <WorkspaceForm
        disabled={!isAdmin(ctx.role)}
        name={ctx.workspace.name}
        website={ctx.workspace.website ?? ""}
        timezone={ctx.workspace.timezone}
      />
    </div>
  );
}
