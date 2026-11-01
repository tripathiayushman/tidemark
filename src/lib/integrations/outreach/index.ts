import type { HandlerTable } from "@/lib/worker/handlers";
import { pushToInstantly } from "./instantly";
import { syncGranola } from "./granola";

// Outreach integrations: Instantly (adds leads with a drafted first email,
// reads outcomes back via webhook) and Granola (read-only meeting mirror).
export const outreachHandlers: HandlerTable = {
  "instantly.push": (db, p) => pushToInstantly(db, p),
  "granola.sync": (db, p) => syncGranola(db, p.connectionId),
};

export {
  connectInstantly,
  listInstantlyCampaigns,
  validateInstantlyKey,
  unregisterInstantlyWebhook,
  INSTANTLY_VARS,
  INSTANTLY_WEBHOOK_SETTING,
} from "./instantly";
export { connectGranola, validateGranolaKey } from "./granola";
