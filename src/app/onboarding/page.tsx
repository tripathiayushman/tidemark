import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getWorkspaceContext, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Logo } from "@/components/tm/logo";
import { CompanyStep, IcpStep, KnowledgeStep } from "./steps";

export const metadata: Metadata = { title: "Set up" };

const STEPS = [
  { key: "company", label: "Your company" },
  { key: "knowledge", label: "What you sell" },
  { key: "icp", label: "Who buys" },
] as const;

export default async function Onboarding(props: PageProps<"/onboarding">) {
  await requireUser();
  const sp = await props.searchParams;
  const ctx = await getWorkspaceContext();
  const forceNew = sp.new === "1";
  if (ctx && ctx.workspace.onboarding_step === "done" && !forceNew) redirect("/home");

  const step = !ctx || forceNew ? "company" : ctx.workspace.onboarding_step === "company" ? "knowledge" : ctx.workspace.onboarding_step;
  let docs: { id: string; name: string; status: string; kind: string }[] = [];
  let hasSeller = false;
  if (ctx && step !== "company") {
    const supabase = await createClient();
    const [{ data }, { data: seller }] = await Promise.all([
      supabase.from("kb_documents").select("id, name, status, kind").eq("workspace_id", ctx.workspace.id).order("created_at"),
      supabase.from("seller_profiles").select("summary").eq("workspace_id", ctx.workspace.id).maybeSingle(),
    ]);
    docs = data ?? [];
    hasSeller = Boolean(seller?.summary);
  }
  const idx = STEPS.findIndex((s) => s.key === step);

  return (
    <main className="min-h-screen">
      <header className="flex h-16 items-center justify-between border-b px-6">
        <Logo />
        <ol className="flex items-center gap-4 text-sm">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i === idx ? "font-medium" : i < idx ? "text-tide" : "text-muted-foreground"}>
              <span className="mr-1.5 tabular-nums">{i + 1}.</span>{s.label}
            </li>
          ))}
        </ol>
      </header>
      <div className="mx-auto max-w-4xl px-6 py-10">
        {step === "company" ? <CompanyStep /> : null}
        {step === "knowledge" && ctx ? <KnowledgeStep website={ctx.workspace.website} docs={docs} /> : null}
        {step === "icp" && ctx ? <IcpStep hasSeller={hasSeller} /> : null}
      </div>
    </main>
  );
}
