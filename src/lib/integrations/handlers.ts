import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandlerTable } from "@/lib/worker/handlers";
import { crmHandlers } from "./crm";
import { gmailHandlers } from "./gmail";
import { outreachHandlers } from "./outreach";
import { getConnection } from "./connections";
import {
  isSandbox, sandboxCrmPull, sandboxCrmPush, sandboxDraft, sandboxGmailSync, sandboxGranolaSync, sandboxInstantlyPush, sandboxSendDue,
} from "./sandbox";

// Job handlers contributed by integrations (merged into the worker's table).
// Sandbox connections (dev only, settings.sandbox=true) are routed to the
// simulated providers in ./sandbox instead of the real APIs.

async function connIsSandbox(db: SupabaseClient, connectionId: string) {
  const conn = await getConnection(db, connectionId);
  return { conn, sandbox: isSandbox(conn) };
}

export const integrationHandlers: HandlerTable = {
  ...crmHandlers,
  ...gmailHandlers,
  ...outreachHandlers,

  "crm.push": async (db, p) => {
    const { conn, sandbox } = await connIsSandbox(db, p.connectionId);
    return sandbox ? sandboxCrmPush(db, conn, p.accountIds) : crmHandlers["crm.push"]!(db, p);
  },
  "crm.pull": async (db, p) => {
    const { conn, sandbox } = await connIsSandbox(db, p.connectionId);
    return sandbox ? sandboxCrmPull(db, conn) : crmHandlers["crm.pull"]!(db, p);
  },
  "gmail.sync": async (db, p) => {
    const { conn, sandbox } = await connIsSandbox(db, p.connectionId);
    return sandbox ? sandboxGmailSync(db, conn) : gmailHandlers["gmail.sync"]!(db, p);
  },
  "granola.sync": async (db, p) => {
    const { conn, sandbox } = await connIsSandbox(db, p.connectionId);
    return sandbox ? sandboxGranolaSync(db, conn) : outreachHandlers["granola.sync"]!(db, p);
  },
  // Real sender skips sandbox mailboxes (no real token), so both run.
  "campaign.send_due": async (db, p) => {
    const sandbox = await sandboxSendDue(db);
    const real = await gmailHandlers["campaign.send_due"]!(db, p);
    return { sandbox, real };
  },
  "campaign.draft": async (db, p) => {
    const { data } = await db
      .from("campaign_enrollments")
      .select("campaigns(mailbox_connection_id, instantly_connection_id)")
      .eq("id", p.enrollmentId)
      .single();
    const c = data?.campaigns as unknown as { mailbox_connection_id: string | null; instantly_connection_id: string | null } | null;
    const connId = c?.mailbox_connection_id ?? c?.instantly_connection_id;
    if (connId && (await connIsSandbox(db, connId)).sandbox) return sandboxDraft(db, p.enrollmentId);
    return gmailHandlers["campaign.draft"]!(db, p);
  },
  "instantly.push": async (db, p) => {
    const { data: campaign } = await db.from("campaigns").select("instantly_connection_id").eq("id", p.campaignId).single();
    if (campaign?.instantly_connection_id && (await connIsSandbox(db, campaign.instantly_connection_id)).sandbox) {
      return sandboxInstantlyPush(db, p.campaignId, p.enrollmentIds);
    }
    return outreachHandlers["instantly.push"]!(db, p);
  },
};
