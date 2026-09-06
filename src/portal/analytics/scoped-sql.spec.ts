import { Prisma } from '@prisma/client';
import { runScoped, runScopedOne } from './scoped-sql';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ScopedBusiness } from './scope/analytics-scope.service';

const business = (branchIds: string[]): ScopedBusiness => ({
  id: 'b-1',
  name: 'Biz',
  dayStartTime: '00:00',
  dayStartMinutes: 0,
  taxRate: 0.12,
  branchIds,
  fromUtc: new Date('2026-03-01T00:00:00.000Z'),
  toUtc: new Date('2026-03-08T00:00:00.000Z'),
  previousFromUtc: new Date('2026-02-22T00:00:00.000Z'),
  previousToUtc: new Date('2026-03-01T00:00:00.000Z'),
});

function fakeRaw(rows: unknown[] = []) {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  return { raw: { $queryRaw: queryRaw } as unknown as PrismaService, queryRaw };
}

const scopedSql = (b: ScopedBusiness) =>
  Prisma.sql`SELECT 1 AS n FROM sales WHERE branch_id = ANY(${b.branchIds}::uuid[])`;

describe('runScoped', () => {
  it('refuses to run when the business has no branches in scope', async () => {
    const { raw } = fakeRaw();
    await expect(runScoped(raw, business([]), scopedSql)).rejects.toThrow(
      /no branches/i,
    );
  });

  it('refuses SQL that carries no branch_id predicate', async () => {
    const { raw } = fakeRaw();
    await expect(
      runScoped(raw, business(['br-1']), () => Prisma.sql`SELECT 1 FROM sales`),
    ).rejects.toThrow(/branch_id/);
  });

  it('runs SQL that is scoped, and returns its rows', async () => {
    const { raw, queryRaw } = fakeRaw([{ n: 1 }]);
    const rows = await runScoped(raw, business(['br-1']), scopedSql);
    expect(rows).toEqual([{ n: 1 }]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('runScopedOne', () => {
  it('returns the single row an aggregate produces', async () => {
    const { raw } = fakeRaw([{ n: 1 }]);
    await expect(
      runScopedOne(raw, business(['br-1']), scopedSql),
    ).resolves.toEqual({ n: 1 });
  });

  it('throws when a query meant to aggregate returns more than one row', async () => {
    const { raw } = fakeRaw([{ n: 1 }, { n: 2 }]);
    await expect(
      runScopedOne(raw, business(['br-1']), scopedSql),
    ).rejects.toThrow(/exactly one row/);
  });
});
