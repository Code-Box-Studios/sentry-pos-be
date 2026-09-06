/*
 * Sales reports (analytics-spec §2) e2e: heatmap, trend, patterns, breakdowns.
 *
 * `salesC` is NET sales throughout — the same figure the overview reports — so
 * a heatmap day and an overview card can never disagree.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { resetDb, closeDb } from './helpers/db';
import { seedSale } from './helpers/sales';

const raw = new PrismaClient();

/** 2 March 2026 is a Monday; 10:00 and 15:00 Manila. */
const MON_10 = new Date('2026-03-02T02:00:00.000Z');
const MON_15 = new Date('2026-03-02T07:00:00.000Z');
/** 4 March 2026, Wednesday, 10:00 Manila. */
const WED_10 = new Date('2026-03-04T02:00:00.000Z');

describe('Portal analytics — sales (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  const server = () => app.getHttpServer();

  async function seedTenant(over: Record<string, unknown> = {}) {
    const owner = await raw.owner.create({
      data: {
        name: 'O',
        email: `o-${Date.now()}-${Math.random()}@t.com`,
        status: 'active',
        maxBusinesses: 5,
      },
    });
    const user = await raw.user.create({
      data: {
        email: `u-${Date.now()}-${Math.random()}@t.com`,
        role: 'owner',
        ownerId: owner.id,
        passwordHash: 'x',
      },
    });
    const business = await raw.business.create({
      data: {
        ownerId: owner.id,
        name: 'B',
        type: 'retail',
        taxRate: '0.12',
        ...over,
      },
    });
    const branch = await raw.branch.create({
      data: { businessId: business.id, name: 'Main', code: 'MN', address: 'x' },
    });
    const terminal = await raw.terminal.create({
      data: { branchId: branch.id, name: 'T1', code: 'T1' },
    });
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    return {
      token: accessToken,
      ownerId: owner.id,
      businessId: business.id,
      branchId: branch.id,
      terminalId: terminal.id,
    };
  }

  const get = (
    token: string,
    path: string,
    query: Record<string, string> = {},
  ) =>
    request(server())
      .get(`/v1/portal/analytics/sales/${path}`)
      .query({ from: '2026-03-01', to: '2026-03-07', ...query })
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await raw.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter(app.get(PrismaService)));
    await app.init();
    auth = app.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  describe('heatmap', () => {
    it('returns one row per day in the range, zero-filled', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'heatmap').expect(200);

      expect(res.body).toHaveLength(7);
      expect(res.body[0]).toEqual({
        date: '2026-03-01',
        salesC: 0,
        transactions: 0,
      });
      expect(res.body[1]).toEqual({
        date: '2026-03-02',
        salesC: 10000,
        transactions: 1,
      });
    });

    it('reports NET sales, so a discount shows up on the day', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [
          {
            qty: 1,
            unitPriceC: 10000,
            discount: { source: 'free', kind: 'fixed', value: 2500 },
          },
        ],
      });

      const res = await get(t.token, 'heatmap').expect(200);
      expect(res.body[1].salesC).toBe(7500);
    });

    it('puts an early-hours sale on the previous day for an 04:00 business', async () => {
      const t = await seedTenant({ dayStartTime: '04:00' });
      // 03:00 Manila on 3 March is 19:00 UTC on 2 March.
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: new Date('2026-03-02T19:00:00.000Z'),
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'heatmap').expect(200);
      const byDate = Object.fromEntries(
        res.body.map((r: any) => [r.date, r.salesC]),
      );
      expect(byDate['2026-03-02']).toBe(10000);
      expect(byDate['2026-03-03']).toBe(0);
    });
  });

  describe('trend', () => {
    it('buckets by day and carries profit where costs are known', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000, costC: 6000 }],
      });

      const res = await get(t.token, 'trend', { granularity: 'day' }).expect(
        200,
      );

      const monday = res.body.find((r: any) => r.bucket === '2026-03-02');
      expect(monday).toEqual({
        bucket: '2026-03-02',
        salesC: 10000,
        grossProfitC: 4000,
        transactions: 1,
      });
    });

    it('leaves profit null on a bucket whose sales are all uncosted', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000, costC: null }],
      });

      const res = await get(t.token, 'trend', { granularity: 'day' }).expect(
        200,
      );
      expect(
        res.body.find((r: any) => r.bucket === '2026-03-02').grossProfitC,
      ).toBeNull();
    });

    it('collapses the week into a single Monday-dated bucket', async () => {
      const t = await seedTenant();
      const common = { branchId: t.branchId, terminalId: t.terminalId };
      await seedSale(raw, {
        ...common,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });
      await seedSale(raw, {
        ...common,
        createdAt: WED_10,
        lines: [{ qty: 1, unitPriceC: 5000 }],
      });

      const res = await get(t.token, 'trend', { granularity: 'week' }).expect(
        200,
      );

      expect(res.body).toEqual([
        {
          bucket: '2026-03-02',
          salesC: 15000,
          grossProfitC: null,
          transactions: 2,
        },
      ]);
    });

    it('rejects an unknown granularity', async () => {
      const t = await seedTenant();
      await get(t.token, 'trend', { granularity: 'fortnight' }).expect(422);
    });
  });

  describe('patterns', () => {
    it('reports all 24 hours and all 7 weekdays, zero-filled', async () => {
      const t = await seedTenant();
      const res = await get(t.token, 'patterns').expect(200);
      expect(res.body.hourOfDay).toHaveLength(24);
      expect(res.body.dayOfWeek).toHaveLength(7);
    });

    it('places a sale at its Manila wall-clock hour, not the business-day offset', async () => {
      const t = await seedTenant({ dayStartTime: '04:00' });
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_15,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'patterns').expect(200);

      // 15:00 Manila reads as 15:00 whatever the business day starts at.
      expect(res.body.hourOfDay[15]).toEqual({
        hour: 15,
        salesC: 10000,
        transactions: 1,
      });
      expect(res.body.hourOfDay[11].salesC).toBe(0);
    });

    it('places a Monday sale on Monday (dayOfWeek 1, Sunday is 0)', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'patterns').expect(200);
      expect(res.body.dayOfWeek[1]).toEqual({
        dayOfWeek: 1,
        salesC: 10000,
        transactions: 1,
      });
    });
  });

  describe('breakdowns', () => {
    it('splits by payment method, order type and branch', async () => {
      const t = await seedTenant();
      const common = {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
      };
      await seedSale(raw, {
        ...common,
        paymentMethod: 'cash',
        orderType: 'takeout',
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });
      await seedSale(raw, {
        ...common,
        paymentMethod: 'gcash',
        orderType: 'dine_in',
        lines: [{ qty: 1, unitPriceC: 5000 }],
      });

      const res = await get(t.token, 'breakdowns').expect(200);

      const byMethod = Object.fromEntries(
        res.body.byPaymentMethod.map((r: any) => [r.method, r.salesC]),
      );
      expect(byMethod).toEqual({ cash: 10000, gcash: 5000 });

      const byType = Object.fromEntries(
        res.body.byOrderType.map((r: any) => [r.orderType, r.transactions]),
      );
      expect(byType).toEqual({ takeout: 1, dine_in: 1 });

      expect(res.body.byBranch).toEqual([
        {
          branchId: t.branchId,
          name: 'Main',
          salesC: 15000,
          transactions: 2,
        },
      ]);
    });

    it('exports every breakdown as one CSV with a section each', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'breakdowns', { format: 'csv' }).expect(
        200,
      );

      expect(res.headers['content-disposition']).toContain(
        'filename="sales-breakdowns-2026-03-01-2026-03-07.csv"',
      );
      expect(res.text).toContain('By payment method');
      expect(res.text).toContain('By order type');
      expect(res.text).toContain('By branch');
      expect(res.text).toContain('100.00');
    });
  });
});
