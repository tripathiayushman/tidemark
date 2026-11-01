// Sending-window math for Gmail campaigns. Pure functions, no dependencies:
// timezone conversion uses Intl.DateTimeFormat only, so this file can be
// exercised by scripts/check-gmail-schedule.ts without a database.
//
// Rules enforced here (from the product spec):
//   * weekdays only: ISO days 1-5, whatever the campaign row says
//   * inside the campaign's sending hours, in the campaign's timezone
//     (start inclusive, end exclusive)
//   * at most 40 emails per mailbox per local day; campaign.daily_cap (<= 40)
//     applies on top of that

export const MAILBOX_DAILY_CAP = 40;
const DAY_MS = 86_400_000;

export interface SendWindow {
  timezone: string;
  /** "HH:MM" or "HH:MM:SS" (Postgres `time`). */
  start: string;
  end: string;
  /** ISO weekdays (1 = Monday … 7 = Sunday). Anything outside 1-5 is ignored. */
  days: readonly number[];
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // ISO 1-7
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of `instant` in `timeZone`. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const out: Partial<LocalParts> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    switch (p.type) {
      case "year": out.year = Number(p.value); break;
      case "month": out.month = Number(p.value); break;
      case "day": out.day = Number(p.value); break;
      case "hour": out.hour = Number(p.value) % 24; break;
      case "minute": out.minute = Number(p.value); break;
      case "second": out.second = Number(p.value); break;
      case "weekday": out.weekday = WEEKDAY[p.value]; break;
    }
  }
  if (out.year == null || out.month == null || out.day == null || out.hour == null || out.minute == null || out.weekday == null) {
    throw new Error(`Could not read local time in ${timeZone}`);
  }
  return { second: 0, ...out } as LocalParts;
}

/** Offset of `timeZone` from UTC at `instant`, in ms (New York in winter → -5h). */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * UTC instant for a wall-clock time in `timeZone`. Two passes settle the
 * offset across DST changes; a non-existent local time (spring-forward gap)
 * lands on the nearest valid instant.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, minutesOfDay: number, timeZone: string): Date {
  const localAsUtc = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  let guess = localAsUtc - tzOffsetMs(new Date(localAsUtc), timeZone);
  guess = localAsUtc - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** "09:00" / "09:00:00" → minutes after midnight. */
export function parseClock(value: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid time "${value}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`Invalid time "${value}"`);
  return h * 60 + min;
}

/** Allowed ISO weekdays: the campaign's days intersected with Monday-Friday. */
export function allowedWeekdays(days: readonly number[]): Set<number> {
  return new Set(days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 5));
}

/** Is `instant` a weekday inside the campaign's sending hours (in its timezone)? */
export function isWithinWindow(instant: Date, w: SendWindow): boolean {
  const days = allowedWeekdays(w.days);
  const start = parseClock(w.start);
  const end = parseClock(w.end);
  if (days.size === 0 || end <= start) return false;
  const p = localParts(instant, w.timezone);
  if (!days.has(p.weekday)) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= start && minutes < end;
}

/**
 * Earliest instant >= `after` at which sending is allowed: `after` itself when
 * already inside the window, otherwise the start of the next allowed window.
 * Null when the window can never open (no weekdays selected, empty hours).
 */
export function nextAllowedTime(after: Date, w: SendWindow): Date | null {
  const days = allowedWeekdays(w.days);
  const start = parseClock(w.start);
  const end = parseClock(w.end);
  if (days.size === 0 || end <= start) return null;
  if (isWithinWindow(after, w)) return after;

  const p = localParts(after, w.timezone);
  for (let i = 0; i < 15; i++) {
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    if (!days.has(weekday)) continue;
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const opens = zonedTimeToUtc(y, mo, d, start, w.timezone);
    if (opens.getTime() > after.getTime()) return opens;
    const closes = zonedTimeToUtc(y, mo, d, end, w.timezone);
    if (after.getTime() < closes.getTime()) return after;
  }
  return null;
}

/** UTC instant of local midnight (start of the local day containing `instant`). */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const p = localParts(instant, timeZone);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, timeZone);
}

/** UTC instant of the next local midnight after `instant`. */
export function startOfNextLocalDay(instant: Date, timeZone: string): Date {
  const p = localParts(instant, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, timeZone);
}

/** First allowed send time on a later local day (used once today's cap is spent). */
export function nextDayWindowStart(now: Date, w: SendWindow): Date | null {
  return nextAllowedTime(startOfNextLocalDay(now, w.timezone), w);
}

/** When the following step may go out: `delayDays` after `sentAt`, pushed into the window. */
export function nextStepSendTime(sentAt: Date, delayDays: number, w: SendWindow): Date | null {
  return nextAllowedTime(new Date(sentAt.getTime() + Math.max(0, delayDays) * DAY_MS), w);
}

/** campaign.daily_cap clamped to 1..40. */
export function effectiveCampaignCap(dailyCap: number | null | undefined): number {
  const n = Number.isFinite(dailyCap) ? Math.floor(dailyCap as number) : MAILBOX_DAILY_CAP;
  return Math.min(MAILBOX_DAILY_CAP, Math.max(1, n));
}

/**
 * How many more emails may go out today: limited by the mailbox-wide 40/day
 * (all campaigns) and by this campaign's own cap.
 */
export function remainingQuota(sentByMailboxToday: number, sentByCampaignToday: number, campaignDailyCap: number | null | undefined): number {
  const mailboxLeft = MAILBOX_DAILY_CAP - sentByMailboxToday;
  const campaignLeft = effectiveCampaignCap(campaignDailyCap) - sentByCampaignToday;
  return Math.max(0, Math.min(mailboxLeft, campaignLeft));
}
