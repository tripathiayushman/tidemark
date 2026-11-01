import { z } from "zod";
import type { Connector, RawRecord } from "./types";
import { optionalEnv } from "@/lib/env";
import { generateStructured } from "@/lib/ai/llm";
import { stateCode, toIsoDate } from "@/lib/pipeline/normalize";

// Trade press via RSS. Feeds come from PRESS_RSS_FEEDS (comma-separated).
// Claude reads each batch of headlines + summaries and pulls out concrete,
// company-specific events (new plant, line expansion, equipment install,
// big contract). Generic industry news yields nothing.

const ItemEvents = z.object({
  events: z.array(
    z.object({
      item_index: z.number().int().describe("Index of the feed item this event came from"),
      company_name: z.string().describe("Operating company the event is about, as named in the item"),
      city: z.string().nullable(),
      state: z.string().nullable().describe("Two-letter US state code if stated"),
      event_type: z.enum(["new_facility", "expansion", "new_line", "equipment", "contract", "relocation", "hiring", "acquisition"]),
      summary: z.string().describe("One factual sentence, only what the item states"),
      amount_usd: z.number().nullable().describe("Investment or contract value if stated"),
    }),
  ),
});

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  feed: string;
}

function parseRss(xml: string, feed: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g) ?? [];
  const tag = (b: string, t: string) => {
    const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
    return m ? decode(m[1]) : "";
  };
  for (const b of blocks) {
    const link = tag(b, "link") || (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "");
    items.push({
      title: tag(b, "title"),
      link,
      description: tag(b, "description") || tag(b, "summary") || tag(b, "content"),
      pubDate: toIsoDate(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || null),
      feed,
    });
  }
  return items;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const EVENT_CATEGORY = {
  new_facility: "building",
  expansion: "building",
  relocation: "building",
  new_line: "equipment_supply",
  equipment: "equipment_supply",
  contract: "contracts",
  hiring: "operations",
  acquisition: "operations",
} as const;

export const tradePress: Connector = {
  id: "press.rss",
  source: "press",
  dataset: "rss",
  label: "Trade press",
  description: "Company-specific expansion, equipment and contract news from trade-press RSS feeds.",
  category: "building",
  defaultLookbackDays: 30,
  schedule: "daily",
  disabledReason: () => (optionalEnv("PRESS_RSS_FEEDS") ? null : "Set PRESS_RSS_FEEDS to a comma-separated list of RSS URLs"),

  async fetch(ctx) {
    const feeds = (optionalEnv("PRESS_RSS_FEEDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const items: FeedItem[] = [];
    for (const feed of feeds) {
      try {
        const res = await fetch(feed, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "TidemarkBot/1.0 (+signals)" } });
        if (!res.ok) { ctx.log(`feed ${feed}: HTTP ${res.status}`); continue; }
        const parsed = parseRss(await res.text(), feed).filter((i) => !i.pubDate || i.pubDate >= ctx.since);
        items.push(...parsed);
        ctx.log(`feed ${feed}: ${parsed.length} recent items`);
      } catch (e) {
        ctx.log(`feed ${feed}: ${(e as Error).message}`);
      }
    }

    const records: RawRecord[] = [];
    for (let i = 0; i < items.length && records.length < ctx.limit; i += 25) {
      const batch = items.slice(i, i + 25);
      const { data } = await generateStructured({
        system:
          "You extract concrete, company-specific events from trade-press items for a B2B prospecting tool that sells to manufacturers. " +
          "Only report events the item explicitly states about a named operating company: a new facility, an expansion, a new production line, " +
          "an equipment installation, a significant contract, a relocation, a large hiring push or an acquisition. Ignore opinion, market reports and " +
          "items with no named company. Never infer facts that are not in the text.",
        prompt: batch.map((it, idx) => `[${idx}] ${it.title}\n${it.description.slice(0, 800)}`).join("\n\n"),
        schema: ItemEvents,
        effort: "low",
        maxTokens: 8000,
      });
      for (const ev of data.events) {
        const item = batch[ev.item_index];
        if (!item) continue;
        records.push({
          source: "press",
          dataset: "rss",
          external_id: `${item.link}#${ev.company_name}`.slice(0, 500),
          record_type: `press_${ev.event_type}`,
          occurred_on: item.pubDate,
          entity_name: ev.company_name,
          entity_city: ev.city,
          entity_state: stateCode(ev.state),
          amount: ev.amount_usd,
          url: item.link,
          raw: { ...ev, headline: item.title, feed: item.feed },
        });
      }
    }
    return { records };
  },

  toSignals(rec) {
    if (!rec.occurred_on) return [];
    const r = rec.raw as z.infer<typeof ItemEvents>["events"][number] & { headline: string };
    return [{
      category: EVENT_CATEGORY[r.event_type],
      signal_type: rec.record_type,
      title: r.headline.length > 120 ? r.headline.slice(0, 117) + "…" : r.headline,
      detail: r.summary,
      occurred_on: rec.occurred_on,
      amount: r.amount_usd,
      location: [r.city, r.state].filter(Boolean).join(", ") || null,
      source_url: rec.url ?? null,
      attributes: { event_type: r.event_type },
      strength: ["new_facility", "expansion", "new_line"].includes(r.event_type) ? 65 : 45,
    }];
  },
};
