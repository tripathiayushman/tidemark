import type { Connector, SignalDraft } from "./types";

// Synthetic demo records (scripts/seed.ts). Each record carries its signal
// pre-built in raw.signal. Companies are fictional, flagged is_synthetic, and
// use reserved *.example domains so nothing can be mistaken for — or sent
// to — a real business.
export const seedConnector: Connector = {
  id: "seed.demo",
  source: "seed",
  dataset: "demo",
  label: "Demo dataset",
  description: "Fictional manufacturers with realistic multi-record timelines, for trying the product.",
  category: "building",
  defaultLookbackDays: 730,
  schedule: "manual",
  disabledReason: () => null,
  async fetch() {
    return { records: [] }; // loaded by `npm run seed`, not fetched
  },
  toSignals(rec) {
    const s = (rec.raw as { signal?: SignalDraft }).signal;
    return s ? [s] : [];
  },
};
