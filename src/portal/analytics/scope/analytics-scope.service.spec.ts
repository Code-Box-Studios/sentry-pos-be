import { Prisma } from '@prisma/client';
import { AnalyticsScopeService } from './analytics-scope.service';
import type { ScopedPrisma } from '../../../prisma/scoped-prisma.provider';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../../common/errors/api-errors';
import type { AnalyticsQueryDto } from '../dto/analytics-query.dto';

type BusinessRow = {
  id: string;
  name: string;
  dayStartTime: string;
  taxRate: Prisma.Decimal;
};
type BranchRow = { id: string; businessId: string };

function makeService(businesses: BusinessRow[], branches: BranchRow[]) {
  const businessFindMany = jest.fn().mockResolvedValue(businesses);
  const branchFindMany = jest.fn().mockResolvedValue(branches);
  const scoped = {
    business: { findMany: businessFindMany },
    branch: { findMany: branchFindMany },
  } as unknown as ScopedPrisma;
  return {
    service: new AnalyticsScopeService(scoped),
    businessFindMany,
    branchFindMany,
  };
}

const midnight: BusinessRow = {
  id: 'b-1',
  name: 'Retail',
  dayStartTime: '00:00',
  taxRate: new Prisma.Decimal('0.12'),
};
const cafe: BusinessRow = {
  id: 'b-2',
  name: 'Cafe',
  dayStartTime: '04:00',
  taxRate: new Prisma.Decimal('0.12'),
};

const query = (over: Partial<AnalyticsQueryDto> = {}): AnalyticsQueryDto => ({
  from: '2026-03-01',
  to: '2026-03-07',
  ...over,
});

describe('AnalyticsScopeService.resolve', () => {
  it('rejects a branchId without a businessId', async () => {
    const { service } = makeService([midnight], []);
    await expect(service.resolve(query({ branchId: 'br-1' }))).rejects.toThrow(
      ValidationFailedError,
    );
  });

  it('rejects a range that ends before it starts', async () => {
    const { service } = makeService([midnight], []);
    await expect(
      service.resolve(query({ from: '2026-03-07', to: '2026-03-01' })),
    ).rejects.toThrow(ValidationFailedError);
  });

  it('rejects a range longer than 366 days', async () => {
    const { service } = makeService([midnight], []);
    await expect(
      service.resolve(query({ from: '2025-01-01', to: '2026-03-01' })),
    ).rejects.toThrow(ValidationFailedError);
  });

  it('excludes demo businesses when no business is named', async () => {
    const { service, businessFindMany } = makeService(
      [midnight],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    await service.resolve(query());
    expect(businessFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isDemo: false } }),
    );
  });

  it('asks for exactly the named business, demo or not', async () => {
    const { service, businessFindMany } = makeService(
      [midnight],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    await service.resolve(query({ businessId: 'b-1' }));
    expect(businessFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b-1' } }),
    );
  });

  it('404s when the named business does not belong to the caller', async () => {
    const { service } = makeService([], []);
    await expect(service.resolve(query({ businessId: 'b-9' }))).rejects.toThrow(
      NotFoundError,
    );
  });

  it('404s when the named branch does not belong to the caller', async () => {
    const { service } = makeService([midnight], []);
    await expect(
      service.resolve(query({ businessId: 'b-1', branchId: 'br-9' })),
    ).rejects.toThrow(NotFoundError);
  });

  it('returns an empty business list — not a 404 — for an owned business with no branches', async () => {
    const { service } = makeService([midnight], []);
    const scope = await service.resolve(query({ businessId: 'b-1' }));
    expect(scope.businesses).toEqual([]);
    expect(scope.branchIds).toEqual([]);
    expect(scope.dayCount).toBe(7);
  });

  it('groups branches under their own business', async () => {
    const { service } = makeService(
      [midnight, cafe],
      [
        { id: 'br-1', businessId: 'b-1' },
        { id: 'br-2', businessId: 'b-1' },
        { id: 'br-3', businessId: 'b-2' },
      ],
    );
    const scope = await service.resolve(query());
    expect(scope.businesses.map((b) => b.branchIds)).toEqual([
      ['br-1', 'br-2'],
      ['br-3'],
    ]);
    expect(scope.branchIds).toEqual(['br-1', 'br-2', 'br-3']);
  });

  it('gives each business its own window, because day starts differ', async () => {
    const { service } = makeService(
      [midnight, cafe],
      [
        { id: 'br-1', businessId: 'b-1' },
        { id: 'br-3', businessId: 'b-2' },
      ],
    );
    const scope = await service.resolve(query());
    const [retail, coffee] = scope.businesses;

    expect(retail.dayStartMinutes).toBe(0);
    expect(retail.fromUtc.toISOString()).toBe('2026-02-28T16:00:00.000Z');
    expect(coffee.dayStartMinutes).toBe(240);
    expect(coffee.fromUtc.toISOString()).toBe('2026-02-28T20:00:00.000Z');
  });

  it('sets the previous window to the equal period immediately before', async () => {
    const { service } = makeService(
      [midnight],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    const scope = await service.resolve(query());
    const [b] = scope.businesses;
    expect(b.previousToUtc).toEqual(b.fromUtc);
    expect(b.toUtc.getTime() - b.fromUtc.getTime()).toBe(
      b.previousToUtc.getTime() - b.previousFromUtc.getTime(),
    );
  });

  it('drops a business whose branches are all filtered out by branchId', async () => {
    const { service } = makeService(
      [midnight],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    const scope = await service.resolve(
      query({ businessId: 'b-1', branchId: 'br-1' }),
    );
    expect(scope.businesses).toHaveLength(1);
    expect(scope.businesses[0].branchIds).toEqual(['br-1']);
  });
});
