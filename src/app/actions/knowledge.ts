"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { enqueue } from "@/lib/jobs";

async function ctxOrThrow() {
  const ctx = await getWorkspaceContext();
  if (!ctx) throw new Error("Sign in and pick a workspace first");
  return ctx;
}

/** Checks quota before the browser uploads a file to storage. */
export async function prepareUpload(files: { name: string; size: number }[]) {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  const { data } = await supabase.from("kb_documents").select("size_bytes").eq("workspace_id", ctx.workspace.id);
  const used = (data ?? []).reduce((s, r) => s + Number(r.size_bytes), 0);
  const incoming = files.reduce((s, f) => s + f.size, 0);
  if (used + incoming > ctx.workspace.kb_quota_bytes) return { error: "This upload would exceed your 1 GB knowledge base." };
  return { ok: true, workspaceId: ctx.workspace.id };
}

/** Registers files the browser already uploaded to knowledge/<ws>/<id>/<name>. */
export async function registerUploads(files: { id: string; name: string; size: number; mime: string; path: string }[]) {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  for (const f of files) {
    if (!f.path.startsWith(`${ctx.workspace.id}/`)) throw new Error("Invalid upload path");
    const { error } = await supabase.from("kb_documents").insert({
      id: f.id,
      workspace_id: ctx.workspace.id,
      name: f.name,
      kind: "upload",
      storage_path: f.path,
      mime_type: f.mime || null,
      size_bytes: f.size,
      status: "queued",
      created_by: ctx.user.id,
    });
    if (error) return { error: error.message };
    await enqueue("kb.process", { documentId: f.id }, { workspaceId: ctx.workspace.id, dedupeKey: `kb:${f.id}`, priority: 30 });
  }
  revalidatePath("/knowledge");
  return { ok: true };
}

export async function addWebsite(url: string) {
  const ctx = await ctxOrThrow();
  const clean = url.trim();
  if (!clean) return { error: "Enter a website" };
  const supabase = await createClient();
  const host = clean.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const { data, error } = await supabase
    .from("kb_documents")
    .insert({ workspace_id: ctx.workspace.id, name: host, kind: "website", source_url: clean, status: "queued", created_by: ctx.user.id })
    .select("id")
    .single();
  if (error) return { error: error.message };
  await enqueue("kb.crawl", { workspaceId: ctx.workspace.id, url: clean, documentId: data.id }, { workspaceId: ctx.workspace.id, dedupeKey: `kb:${data.id}`, priority: 30 });
  revalidatePath("/knowledge");
  return { ok: true };
}

export async function addNote(title: string, text: string) {
  const ctx = await ctxOrThrow();
  if (!text.trim()) return { error: "Write something first" };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("kb_documents")
    .insert({ workspace_id: ctx.workspace.id, name: title.trim() || "Note", kind: "note", summary: text, size_bytes: Buffer.byteLength(text), status: "queued", created_by: ctx.user.id })
    .select("id")
    .single();
  if (error) return { error: error.message };
  await enqueue("kb.process", { documentId: data.id }, { workspaceId: ctx.workspace.id, dedupeKey: `kb:${data.id}`, priority: 30 });
  revalidatePath("/knowledge");
  return { ok: true };
}

export async function reprocessDocument(id: string) {
  const ctx = await ctxOrThrow();
  await enqueue("kb.process", { documentId: id }, { workspaceId: ctx.workspace.id, dedupeKey: `kb:${id}`, priority: 30 });
  const supabase = await createClient();
  await supabase.from("kb_documents").update({ status: "queued" }).eq("id", id);
  revalidatePath("/knowledge");
}

export async function deleteDocument(id: string) {
  const ctx = await ctxOrThrow();
  const supabase = await createClient();
  const { data: doc } = await supabase.from("kb_documents").select("storage_path").eq("id", id).eq("workspace_id", ctx.workspace.id).single();
  if (doc?.storage_path) await supabase.storage.from("knowledge").remove([doc.storage_path]);
  await supabase.from("kb_documents").delete().eq("id", id).eq("workspace_id", ctx.workspace.id);
  await enqueue("seller.profile", { workspaceId: ctx.workspace.id }, { workspaceId: ctx.workspace.id, dedupeKey: `seller:${ctx.workspace.id}` });
  revalidatePath("/knowledge");
}

export async function refreshSellerProfile() {
  const ctx = await ctxOrThrow();
  await enqueue("seller.profile", { workspaceId: ctx.workspace.id }, { workspaceId: ctx.workspace.id, dedupeKey: `seller:${ctx.workspace.id}`, priority: 20 });
  revalidatePath("/knowledge");
}

export async function updateSellerProfile(formData: FormData) {
  const ctx = await ctxOrThrow();
  const lines = (k: string) => String(formData.get(k) ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const supabase = await createClient();
  const { error } = await supabase.from("seller_profiles").upsert({
    workspace_id: ctx.workspace.id,
    summary: String(formData.get("summary") ?? "").trim() || null,
    buyer_problems: lines("buyer_problems"),
    buying_triggers: lines("buying_triggers"),
    proof_points: lines("proof_points"),
    differentiators: lines("differentiators"),
    competitors: lines("competitors"),
    updated_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };
  revalidatePath("/knowledge");
  return { ok: true };
}

export async function loadDemoDataAction() {
  const ctx = await ctxOrThrow();
  await enqueue("demo.seed", { workspaceId: ctx.workspace.id }, { workspaceId: ctx.workspace.id, dedupeKey: `demo:${ctx.workspace.id}`, priority: 10 });
  return { ok: true };
}
