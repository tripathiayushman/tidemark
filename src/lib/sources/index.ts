import type { Connector } from "./types";
import { usaspendingContracts } from "./usaspending";
import { permitConnectors } from "./permits";
import { fmcsaCarriers } from "./fmcsa";
import { sba504, sba7a } from "./sba";
import { tradePress } from "./press";
import { seedConnector } from "./seed";

// Registry of every data connector. Customs shipments and supplier switches
// need a licensed bill-of-lading provider (ImportGenius, Panjiva, ...); until
// one is wired in, those signal types come only from the synthetic seed set.
export const CONNECTORS: Connector[] = [
  usaspendingContracts,
  ...permitConnectors,
  fmcsaCarriers,
  sba504,
  sba7a,
  tradePress,
  seedConnector,
];

export function getConnector(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

export function connectorFor(source: string, dataset: string): Connector | undefined {
  return CONNECTORS.find((c) => c.source === source && c.dataset === dataset);
}

export type { Connector } from "./types";
