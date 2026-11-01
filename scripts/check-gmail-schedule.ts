// Self-check for the Gmail campaign sending window and daily caps.
// Pure date math, no database or API calls. Exits non-zero on failure.
//   npx tsx scripts/check-gmail-schedule.ts
import {
  MAILBOX_DAILY_CAP,
  effectiveCampaignCap,
  isWithinWindow,
  nextAllowedTime,
  nextDayWindowStart,
  nextStepSendTime,
  parseClock,
  remainingQuota,
  startOfLocalDay,
  type SendWindow,
} from "@/lib/integrations/gmail/schedule";

let failures = 0;
let passes = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const a = actual instanceof Date ? actual.toISOString() : actual;
  const e = expected instanceof Date ? expected.toISOString() : expected;
  if (a === e) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL ${name}\n     expected ${String(e)}\n     got      ${String(a)}`);
  }
}

const at = (iso: string) => new Date(iso);

async function main() {
  const ny: SendWindow = { timezone: "America/New_York", start: "09:00:00", end: "17:00:00", days: [1, 2, 3, 4, 5] };

  // ── Weekday vs weekend (2026-11-01 is a Sunday; US DST ended that morning, NY = UTC-5) ──
  check("Mon 10:00 NY is inside", isWithinWindow(at("2026-11-02T15:00:00Z"), ny), true);
  check("Mon 08:59 NY is before the window", isWithinWindow(at("2026-11-02T13:59:00Z"), ny), false);
  check("Fri 16:59 NY is inside", isWithinWindow(at("2026-11-06T21:59:00Z"), ny), true);
  check("Fri 17:00 NY is outside (end exclusive)", isWithinWindow(at("2026-11-06T22:00:00Z"), ny), false);
  check("Sat 10:00 NY is outside", isWithinWindow(at("2026-11-07T15:00:00Z"), ny), false);
  check("Sun 10:00 NY is outside", isWithinWindow(at("2026-11-08T15:00:00Z"), ny), false);

  // ── Next allowed time ──
  const inside = at("2026-11-03T16:30:00Z");
  check("inside → same instant", nextAllowedTime(inside, ny), inside);
  check("Tue 07:30 NY → Tue 09:00", nextAllowedTime(at("2026-11-03T12:30:00Z"), ny), at("2026-11-03T14:00:00Z"));
  check("Tue 18:00 NY → Wed 09:00", nextAllowedTime(at("2026-11-03T23:00:00Z"), ny), at("2026-11-04T14:00:00Z"));
  check("Fri 17:00 NY → Mon 09:00", nextAllowedTime(at("2026-11-06T22:00:00Z"), ny), at("2026-11-09T14:00:00Z"));
  check("Sat 10:00 NY → Mon 09:00", nextAllowedTime(at("2026-11-07T15:00:00Z"), ny), at("2026-11-09T14:00:00Z"));

  // ── Weekend days in the campaign row are ignored; subsets are honored ──
  const allWeek: SendWindow = { ...ny, days: [1, 2, 3, 4, 5, 6, 7] };
  check("days incl. Sat/Sun: Sat still outside", isWithinWindow(at("2026-11-07T15:00:00Z"), allWeek), false);
  check("days incl. Sat/Sun: Sat → Mon", nextAllowedTime(at("2026-11-07T15:00:00Z"), allWeek), at("2026-11-09T14:00:00Z"));
  const mwf: SendWindow = { ...ny, days: [1, 3, 5] };
  check("MWF: Tue 10:00 outside", isWithinWindow(at("2026-11-03T15:00:00Z"), mwf), false);
  check("MWF: Tue 10:00 → Wed 09:00", nextAllowedTime(at("2026-11-03T15:00:00Z"), mwf), at("2026-11-04T14:00:00Z"));
  check("weekend-only days → never", nextAllowedTime(at("2026-11-03T15:00:00Z"), { ...ny, days: [6, 7] }), null);
  check("empty days → never", nextAllowedTime(at("2026-11-03T15:00:00Z"), { ...ny, days: [] }), null);

  // ── Timezone boundaries ──
  const india: SendWindow = { timezone: "Asia/Kolkata", start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] };
  const monLateNy = at("2026-11-03T03:30:00Z"); // Mon 22:30 in NY, Tue 09:00 in Kolkata
  check("same instant: outside in NY", isWithinWindow(monLateNy, ny), false);
  check("same instant: inside in Kolkata (start inclusive)", isWithinWindow(monLateNy, india), true);

  const lateDay = { start: "09:00", end: "23:00", days: [1, 2, 3, 4, 5] };
  const friLa = at("2026-11-07T04:00:00Z"); // Fri 20:00 in Los Angeles, Sat 13:00 in Tokyo
  check("Fri evening in LA is inside", isWithinWindow(friLa, { ...lateDay, timezone: "America/Los_Angeles" }), true);
  check("same instant is Saturday in Tokyo → outside", isWithinWindow(friLa, { ...lateDay, timezone: "Asia/Tokyo" }), false);
  check("Tokyo Sat → Mon 09:00 JST", nextAllowedTime(friLa, { ...lateDay, timezone: "Asia/Tokyo" }), at("2026-11-09T00:00:00Z"));

  // DST: window start moves from 14:00Z (EST) to 13:00Z (EDT) on 2026-03-08.
  check("Sat before DST → Mon 09:00 EDT", nextAllowedTime(at("2026-03-07T12:00:00Z"), ny), at("2026-03-09T13:00:00Z"));
  check("Fri before DST → 09:00 EST", nextAllowedTime(at("2026-03-06T05:00:00Z"), ny), at("2026-03-06T14:00:00Z"));

  // Local midnight (the cap's "today") across the DST change on 2026-11-01.
  check("local midnight of Sun Nov 1 NY is 04:00Z (still EDT)", startOfLocalDay(at("2026-11-02T03:00:00Z"), "America/New_York"), at("2026-11-01T04:00:00Z"));
  check("local midnight of Mon Nov 2 NY is 05:00Z (EST)", startOfLocalDay(at("2026-11-02T15:00:00Z"), "America/New_York"), at("2026-11-02T05:00:00Z"));
  check("local midnight in Kolkata", startOfLocalDay(monLateNy, "Asia/Kolkata"), at("2026-11-02T18:30:00Z"));

  // ── Follow-up delays and cap roll-over ──
  check("Thu 16:00 + 3 days (Sun) → Mon 09:00", nextStepSendTime(at("2026-11-05T21:00:00Z"), 3, ny), at("2026-11-09T14:00:00Z"));
  check("Mon 10:00 + 1 day → Tue 10:00", nextStepSendTime(at("2026-11-02T15:00:00Z"), 1, ny), at("2026-11-03T15:00:00Z"));
  check("delay 0 inside window → now", nextStepSendTime(at("2026-11-02T15:00:00Z"), 0, ny), at("2026-11-02T15:00:00Z"));
  check("cap hit Mon 10:00 → Tue 09:00", nextDayWindowStart(at("2026-11-02T15:00:00Z"), ny), at("2026-11-03T14:00:00Z"));
  check("cap hit Fri 10:00 → Mon 09:00", nextDayWindowStart(at("2026-11-06T15:00:00Z"), ny), at("2026-11-09T14:00:00Z"));

  // ── Daily caps ──
  check("mailbox cap is 40", MAILBOX_DAILY_CAP, 40);
  check("39 sent → 1 left", remainingQuota(39, 0, 40), 1);
  check("40 sent → 0 left", remainingQuota(40, 0, 40), 0);
  check("41 sent (other campaigns) → 0 left", remainingQuota(41, 0, 40), 0);
  check("campaign cap 25 reached → 0 left", remainingQuota(10, 25, 25), 0);
  check("campaign cap 25, 20 sent → 5 left", remainingQuota(10, 20, 25), 5);
  check("mailbox cap binds before campaign cap", remainingQuota(38, 5, 40), 2);
  check("campaign cap above 40 clamps to 40", effectiveCampaignCap(60), 40);
  check("campaign cap below 1 clamps to 1", effectiveCampaignCap(0), 1);
  check("null campaign cap → 40", effectiveCampaignCap(null), 40);

  // ── Clock parsing ──
  check("parse 09:00", parseClock("09:00"), 540);
  check("parse 17:30:00", parseClock("17:30:00"), 1050);
  let threw = false;
  try { parseClock("9am"); } catch { threw = true; }
  check("parse rejects 9am", threw, true);
  check("end <= start → never inside", isWithinWindow(at("2026-11-02T15:00:00Z"), { ...ny, start: "17:00", end: "09:00" }), false);

  if (failures > 0) {
    console.error(`\n${failures} failed, ${passes} passed`);
    process.exit(1);
  }
  console.log(`gmail schedule: all ${passes} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
