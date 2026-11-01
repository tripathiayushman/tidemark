import { format, formatDistanceToNowStrict, isSameYear, parseISO } from "date-fns";

/** ISO timestamp N days from now (negative = past). */
export function isoFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** YYYY-MM-DD N days from now. */
export function dateFromNow(days = 0): string {
  return isoFromNow(days).slice(0, 10);
}

export function d(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const dt = iso.length === 10 ? parseISO(iso + "T00:00:00") : new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** "Mar 4" this year, "Mar 4, 2025" otherwise. */
export function shortDate(iso: string | null | undefined): string {
  const dt = d(iso);
  if (!dt) return "—";
  return isSameYear(dt, new Date()) ? format(dt, "MMM d") : format(dt, "MMM d, yyyy");
}

export function ago(iso: string | null | undefined): string {
  const dt = d(iso);
  return dt ? `${formatDistanceToNowStrict(dt)} ago` : "—";
}

/** Contact window as shown in the prospects list: "Now – Dec 15". */
export function windowLabel(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  const today = new Date().toISOString().slice(0, 10);
  const s = !start || start <= today ? "Now" : shortDate(start);
  return end ? `${s} – ${shortDate(end)}` : s;
}

export function daysLeft(end: string | null): number | null {
  const dt = d(end);
  if (!dt) return null;
  return Math.ceil((dt.getTime() - Date.now()) / 86_400_000);
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function money(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  return name.replace(/\b(inc|llc|co|corp)\b\.?/gi, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}
