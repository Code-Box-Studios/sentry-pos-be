/**
 * Business-day arithmetic (project-spec §7 "Business day").
 *
 * A business day runs `[date + dayStartTime, nextDate + dayStartTime)` in
 * Asia/Manila. A 2 AM cafe setting `04:00` puts a 3 AM sale on the previous
 * calendar date, which is the entire point of the field.
 *
 * The Philippines has observed no DST since 1978, so Asia/Manila is UTC+8 all
 * year and fixed-offset arithmetic is exact here. Anywhere with DST would need
 * a real timezone library; this deliberately does not.
 */

export const MANILA_OFFSET_MINUTES = 8 * 60;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** `HH:mm` to minutes past midnight. Throws on anything else. */
export function parseDayStart(dayStartTime: string): number {
  const match = HHMM.exec(dayStartTime);
  if (!match) {
    throw new Error(`Invalid dayStartTime: ${JSON.stringify(dayStartTime)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = DATE.exec(date);
  if (!match) throw new Error(`Invalid date: ${JSON.stringify(date)}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** The UTC instant at which the given business day begins. */
export function businessDayStartUtc(
  date: string,
  dayStartMinutes: number,
): Date {
  const { y, m, d } = parseDate(date);
  // Manila wall clock to UTC: subtract the offset from the local minute count.
  return new Date(
    Date.UTC(y, m - 1, d, 0, dayStartMinutes - MANILA_OFFSET_MINUTES),
  );
}

/** The business day (YYYY-MM-DD) an instant falls on. */
export function businessDayOf(instant: Date, dayStartMinutes: number): string {
  const shifted = new Date(
    instant.getTime() + (MANILA_OFFSET_MINUTES - dayStartMinutes) * 60_000,
  );
  return shifted.toISOString().slice(0, 10);
}

/** Every business day from `from` to `to`, both inclusive. */
export function businessDaySeries(from: string, to: string): string[] {
  const start = businessDayStartUtc(from, 0).getTime();
  const end = businessDayStartUtc(to, 0).getTime();
  if (end < start) {
    throw new Error(`Range ends before it starts: ${from}..${to}`);
  }
  const days: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    days.push(businessDayOf(new Date(t), 0));
  }
  return days;
}

/** `[fromUtc, toUtc)` covering both endpoint days in full. */
export function businessDayRangeUtc(
  from: string,
  to: string,
  dayStartMinutes: number,
): { fromUtc: Date; toUtc: Date } {
  const fromUtc = businessDayStartUtc(from, dayStartMinutes);
  const lastStart = businessDayStartUtc(to, dayStartMinutes);
  if (lastStart.getTime() < fromUtc.getTime()) {
    throw new Error(`Range ends before it starts: ${from}..${to}`);
  }
  return { fromUtc, toUtc: new Date(lastStart.getTime() + DAY_MS) };
}

/** The equal-length window immediately preceding `[fromUtc, toUtc)`. */
export function previousPeriod(
  fromUtc: Date,
  toUtc: Date,
): { fromUtc: Date; toUtc: Date } {
  const length = toUtc.getTime() - fromUtc.getTime();
  return {
    fromUtc: new Date(fromUtc.getTime() - length),
    toUtc: new Date(fromUtc),
  };
}
