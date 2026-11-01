import type { HandlerTable } from "@/lib/worker/handlers";
import { crmHandlers } from "./crm";
import { gmailHandlers } from "./gmail";
import { outreachHandlers } from "./outreach";

// Job handlers contributed by integrations (merged into the worker's table).
export const integrationHandlers: HandlerTable = {
  ...crmHandlers,
  ...gmailHandlers,
  ...outreachHandlers,
};
