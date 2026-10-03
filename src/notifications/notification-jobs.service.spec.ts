import { latestBoundary } from './notification-jobs.service';

test.each([
  ['2026-09-15T19:59:59Z', '04:00', '2026-09-14T20:00:00.000Z'],
  ['2026-09-15T20:00:00Z', '04:00', '2026-09-15T20:00:00.000Z'],
  ['2026-09-15T16:00:00Z', '00:00', '2026-09-15T16:00:00.000Z'],
  ['2026-12-31T20:30:00Z', '04:30', '2026-12-31T20:30:00.000Z'],
])('business cutoff %s %s is %s', (now, cutoff, expected) => {
  expect(latestBoundary(new Date(now), cutoff).toISOString()).toBe(expected);
});
