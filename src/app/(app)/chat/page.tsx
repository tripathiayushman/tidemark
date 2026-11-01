import type { Metadata } from "next";
import { requireWorkspace } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ChatView } from "./chat-view";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatPage(props: PageProps<"/chat">) {
  const ctx = await requireWorkspace();
  const sp = await props.searchParams;
  const threadId = typeof sp.t === "string" ? sp.t : null;
  const supabase = await createClient();
  const { data: threads } = await supabase
    .from("chat_threads")
    .select("id, title, updated_at")
    .eq("workspace_id", ctx.workspace.id)
    .eq("user_id", ctx.user.id)
    .order("updated_at", { ascending: false })
    .limit(40);
  let initial: { role: "user" | "assistant"; text: string }[] = [];
  if (threadId) {
    const { data } = await supabase.from("chat_messages").select("role, display_text").eq("thread_id", threadId).order("id");
    initial = (data ?? []).filter((m) => m.display_text).map((m) => ({ role: m.role as "user" | "assistant", text: m.display_text as string }));
  }
  return <ChatView key={threadId ?? "new"} threads={threads ?? []} threadId={threadId} initial={initial} />;
}
