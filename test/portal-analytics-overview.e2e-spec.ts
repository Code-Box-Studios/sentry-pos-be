/*
 * Overview report (analytics-spec §1) e2e. Sales are seeded through the real
 * totals engine (`test/helpers/sales.ts`), so the KPIs are checked against the
 * same arithmetic the POS produces.
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

/** 2 March 2026, 10:00 Manila — comfortably inside a midnight business day. */
const DURING = new Date('2026-03-02T02:00:00.000Z');
/** 23 February 2026, 10:00 Manila — inside the previous 7-day window. */
const BEFORE = new Date('2026-02-23T02:00:00.000Z');

describe('Portal analytics — overview (e2e)', () => {
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

  const overview = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/overview')
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

  it('reports gross, discounts and net sales for the range', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { qty: 2, unitPriceC: 10000 },
        {
          qty: 1,
          unitPriceC: 5000,
          discount: { source: 'free', kind: 'fixed', value: 1000 },
        },
      ],
    });

    const res = await overview(t.token).expect(200);

    expect(res.body.grossSalesC.value).toBe(25000);
    expect(res.body.discountsC.value).toBe(1000);
    expect(res.body.netSalesC.value).toBe(24000);
    expect(res.body.transactions.value).toBe(1);
    expect(res.body.averageBasketC.value).toBe(24000);
  });

  it('counts voids and refunds but keeps their money out of sales', async () => {
    const t = await seedTenant();
    const common = {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
    };
    await seedSale(raw, { ...common, lines: [{ qty: 1, unitPriceC: 10000 }] });
    await seedSale(raw, {
      ...common,
      status: 'voided',
      lines: [{ qty: 1, unitPriceC: 90000 }],
    });
    await seedSale(raw, {
      ...common,
      status: 'refunded',
      lines: [{ qty: 1, unitPriceC: 70000 }],
    });

    const res = await overview(t.token).expect(200);

    expect(res.body.grossSalesC.value).toBe(10000);
    expect(res.body.transactions.value).toBe(1);
    expect(res.body.voidCount.value).toBe(1);
    expect(res.body.refundCount.value).toBe(1);
  });

  it('compares against the equal period immediately before', async () => {
    const t = await seedTenant();
    const common = { branchId: t.branchId, terminalId: t.terminalId };
    await seedSale(raw, {
      ...common,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 15000 }],
    });
    await seedSale(raw, {
      ...common,
      createdAt: BEFORE,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await overview(t.token).expect(200);

    expect(res.body.grossSalesC.value).toBe(15000);
    expect(res.body.grossSalesC.previous).toBe(10000);
    expect(res.body.grossSalesC.changePct).toBeCloseTo(0.5, 10);
  });

  it('reports margin as null — never zero — when costs are unset', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 10000, costC: null }],
    });

    const res = await overview(t.token).expect(200);

    expect(res.body.grossProfitC.value).toBeNull();
    expect(res.body.marginPct.value).toBeNull();
    expect(res.body.uncostedRevenueC).toBe(10000);
  });

  it('computes profit from costed lines and says how much revenue it covers', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { qty: 2, unitPriceC: 10000, costC: 6000 },
        { qty: 1, unitPriceC: 5000, costC: null },
      ],
    });

    const res = await overview(t.token).expect(200);

    expect(res.body.grossProfitC.value).toBe(8000);
    expect(res.body.marginPct.value).toBeCloseTo(0.4, 10);
    expect(res.body.costedRevenueC).toBe(20000);
    expect(res.body.uncostedRevenueC).toBe(5000);
  });

  it('includes modifier prices in revenue', async () => {
    const t = await seedTenant();
    const sale = await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          qty: 2,
          unitPriceC: 10000,
          costC: 4000,
          modifiers: [
            {
              groupId: 'g',
              modifierId: 'm',
              name: 'Oat milk',
              priceDeltaC: 2000,
            },
          ],
        },
      ],
    });

    const res = await overview(t.token).expect(200);

    // 2 x (100.00 + 20.00) = 240.00 — not 2 x 100.00.
    expect(res.body.grossSalesC.value).toBe(24000);
    expect(res.body.grossSalesC.value).toBe(sale.subtotal);
    expect(res.body.costedRevenueC).toBe(24000);
  });

  it('returns zeros for an owned business that has no branches yet', async () => {
    const t = await seedTenant();
    const empty = await raw.business.create({
      data: {
        ownerId: t.ownerId,
        name: 'Fresh',
        type: 'retail',
        taxRate: '0.12',
      },
    });

    const res = await overview(t.token, { businessId: empty.id }).expect(200);

    expect(res.body.grossSalesC.value).toBe(0);
    expect(res.body.transactions.value).toBe(0);
    expect(res.body.grossProfitC.value).toBeNull();
  });

  it('rejects a branchId without a businessId, and a backwards range', async () => {
    const t = await seedTenant();
    await overview(t.token, { branchId: t.branchId }).expect(422);
    await overview(t.token, { from: '2026-03-07', to: '2026-03-01' }).expect(
      422,
    );
  });

  it('exports the same numbers as CSV, in pesos, as an attachment', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 125000 }],
    });

    const res = await overview(t.token, { format: 'csv' }).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="overview-2026-03-01-2026-03-07.csv"',
    );
    expect(res.text).toContain('1250.00');
  });

  it('audits the read, and an export as an export', async () => {
    const t = await seedTenant();
    await overview(t.token).expect(200);
    await overview(t.token, { format: 'csv' }).expect(200);

    const rows = await raw.auditLog.findMany({
      where: { businessId: t.businessId },
      orderBy: { createdAt: 'asc' },
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('audit.report_read');
    expect(actions).toContain('audit.report_export');
  });
});
