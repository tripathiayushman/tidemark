import type { HandlerTable } from "@/lib/worker/handlers";
import { draftNextCampaignMessage, sendDueCampaignMessages } from "./send";
import { syncGmail } from "./sync";

// Gmail integration jobs:
//   gmail.sync         mirror threads with chosen prospects; stop sequences on reply/bounce
//   campaign.send_due  send due campaign emails (window, weekdays, 40/day/mailbox, one at a time)
//   campaign.draft     pre-create the next step's message as a reviewable draft
export const gmailHandlers: HandlerTable = {
  "gmail.sync": (db, p) => syncGmail(db, p.connectionId),
  "campaign.send_due": (db) => sendDueCampaignMessages(db),
  "campaign.draft": (db, p) => draftNextCampaignMessage(db, p.enrollmentId),
};
