// Mirrors public.company_key / public.normalize_domain in SQL. Keep in sync.

const LEGAL_SUFFIXES = new Set([
  "the", "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "corp", "corporation",
  "co", "company", "plc", "pc", "pllc", "holdings", "group",
]);

export function companyKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.toLowerCase();
  s = s.replace(/\s+(d\/?b\/?a|aka)\s+.*$/g, "");
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9 ]/g, " ");
  s = s.replace(/\bl l c\b/g, " ");
  const words = s.split(/\s+/).filter((w) => w && !LEGAL_SUFFIXES.has(w));
  const out = words.join(" ").trim();
  return out.length ? out : null;
}

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#:].*$/, "");
  return s.length && s.includes(".") ? s : null;
}

/** "ACME FABRICATION LLC" → "Acme Fabrication LLC" (keeps short acronyms). */
export function titleCaseCompany(raw: string): string {
  const keepUpper = new Set(["LLC", "LLP", "LP", "INC", "USA", "US", "PC", "PLC", "II", "III", "IV", "CNC", "HVAC", "LTD"]);
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => {
      const bare = w.replace(/[^A-Za-z]/g, "").toUpperCase();
      if (keepUpper.has(bare)) return w.toUpperCase();
      if (w.length <= 3 && /^[A-Z&]+$/.test(w) && !["THE", "AND", "OF"].includes(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ")
    .replace(/\bInc\b\.?/i, "Inc.");
}

export function zip5(raw: string | null | undefined): string | null {
  const m = raw?.match(/\d{5}/);
  return m ? m[0] : null;
}

export function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function daysBetween(a: string | Date, b: string | Date): number {
  const da = typeof a === "string" ? new Date(a + (a.length === 10 ? "T00:00:00Z" : "")) : a;
  const db = typeof b === "string" ? new Date(b + (b.length === 10 ? "T00:00:00Z" : "")) : b;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export function isoDaysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

export function formatMoney(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}
