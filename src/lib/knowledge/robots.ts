// Minimal robots.txt support for Tidemark's crawlers (RFC 9309 subset):
// groups for our user agent ("tidemarkbot") or "*", Allow/Disallow path
// prefixes with "*" wildcards and "$" anchors; the longest matching rule
// wins and Allow wins ties. A missing robots.txt (4xx) means allowed; if it
// cannot be fetched at all (5xx / network), we assume disallowed.

const AGENT = "tidemarkbot";

interface Rule { allow: boolean; pattern: string }

export function parseRobots(text: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (!current) continue;
      if (key === "disallow" && value === "") continue; // empty Disallow = allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && AGENT.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

export function isAllowed(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!matches(r.pattern, path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

const cache = new Map<string, Promise<Rule[] | null>>();

/** Rules for an origin, or null meaning "do not crawl" (robots.txt unreachable). */
export function robotsFor(origin: string): Promise<Rule[] | null> {
  if (!cache.has(origin)) {
    cache.set(origin, (async () => {
      try {
        const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "TidemarkBot/1.0" }, redirect: "follow" });
        if (res.status >= 400 && res.status < 500) return [];
        if (!res.ok) return null;
        return parseRobots(await res.text());
      } catch {
        return null;
      }
    })());
  }
  return cache.get(origin)!;
}

export async function allowedToFetch(url: string): Promise<boolean> {
  const u = new URL(url);
  const rules = await robotsFor(u.origin);
  return rules !== null && isAllowed(rules, u.pathname + u.search);
}
