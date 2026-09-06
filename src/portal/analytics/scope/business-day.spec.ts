import {
  addDays,
  businessDayOf,
  businessDayRangeUtc,
  businessDaySeries,
  businessDayStartUtc,
  parseDayStart,
  previousPeriod,
} from './business-day';

describe('parseDayStart', () => {
  it('reads HH:mm as minutes past midnight', () => {
    expect(parseDayStart('00:00')).toBe(0);
    expect(parseDayStart('04:00')).toBe(240);
    expect(parseDayStart('23:59')).toBe(1439);
  });

  it('rejects anything that is not HH:mm', () => {
    expect(() => parseDayStart('4:00')).toThrow();
    expect(() => parseDayStart('24:00')).toThrow();
    expect(() => parseDayStart('')).toThrow();
  });
});

describe('businessDayStartUtc', () => {
  it('starts a midnight business day at 16:00 UTC the day before', () => {
    expect(businessDayStartUtc('2026-03-02', 0).toISOString()).toBe(
      '2026-03-01T16:00:00.000Z',
    );
  });

  it('starts an 04:00 business day at 20:00 UTC the day before', () => {
    expect(businessDayStartUtc('2026-03-02', 240).toISOString()).toBe(
      '2026-03-01T20:00:00.000Z',
    );
  });
});

describe('businessDayOf', () => {
  // 03:00 Manila on 2 March is 19:00 UTC on 1 March.
  const threeAm = new Date('2026-03-01T19:00:00.000Z');

  it('puts a 3 AM sale on the same date for a midnight business', () => {
    expect(businessDayOf(threeAm, 0)).toBe('2026-03-02');
  });

  it('puts a 3 AM sale on the PREVIOUS date for an 04:00 cafe', () => {
    expect(businessDayOf(threeAm, 240)).toBe('2026-03-01');
  });

  it('puts a 5 AM sale on the same date for an 04:00 cafe', () => {
    const fiveAm = new Date('2026-03-01T21:00:00.000Z');
    expect(businessDayOf(fiveAm, 240)).toBe('2026-03-02');
  });
});

describe('businessDaySeries', () => {
  it('lists every date inclusive of both ends', () => {
    expect(businessDaySeries('2026-03-01', '2026-03-04')).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
  });

  it('returns a single day when from equals to', () => {
    expect(businessDaySeries('2026-03-01', '2026-03-01')).toEqual([
      '2026-03-01',
    ]);
  });

  it('crosses a month boundary', () => {
    expect(businessDaySeries('2026-02-27', '2026-03-01')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
  });

  it('throws when `to` precedes `from`', () => {
    expect(() => businessDaySeries('2026-03-04', '2026-03-01')).toThrow();
  });
});

describe('businessDayRangeUtc', () => {
  it('spans from the first day start to the day start AFTER the last date', () => {
    const range = businessDayRangeUtc('2026-03-01', '2026-03-02', 0);
    expect(range.fromUtc.toISOString()).toBe('2026-02-28T16:00:00.000Z');
    expect(range.toUtc.toISOString()).toBe('2026-03-02T16:00:00.000Z');
  });

  it('covers exactly 24 hours for a single day', () => {
    const range = businessDayRangeUtc('2026-03-01', '2026-03-01', 240);
    expect(range.toUtc.getTime() - range.fromUtc.getTime()).toBe(86_400_000);
  });
});

describe('previousPeriod', () => {
  it('is the equal-length window ending where this one starts', () => {
    const fromUtc = new Date('2026-03-08T16:00:00.000Z');
    const toUtc = new Date('2026-03-15T16:00:00.000Z');
    const prev = previousPeriod(fromUtc, toUtc);
    expect(prev.toUtc).toEqual(fromUtc);
    expect(prev.fromUtc.toISOString()).toBe('2026-03-01T16:00:00.000Z');
  });
});

describe('addDays', () => {
  it('moves forward and backward across a month boundary', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-08', -7)).toBe('2026-03-01');
  });
});
