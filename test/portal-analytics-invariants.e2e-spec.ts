/*
 * Properties that must hold across reports, not within one.
 *
 * The modifier case is the one that matters most: `sale_items.unit_price` is
 * the BASE price and priced modifiers live in the jsonb array, so a report that
 * multiplies qty by unit_price alone silently understates revenue on every such
 * line. Here the report must agree with `sales.subtotal`, which the engine
 * computed.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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

const DURING = new Date('2026-03-02T02:00:00.000Z');
const RANGE = { from: '2026-03-01', to: '2026-03-07' };

describe('Portal analytics — cross-report invariants (e2e)', () => {
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
      .get(`/v1/portal/${path}`)
      .query({ ...RANGE, ...query })
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

  it('matches the stored subtotal when every line carries a priced modifier', async () => {
    const t = await seedTenant();
    const sale = await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          qty: 2.5,
          unitPriceC: 13300,
          modifiers: [
            {
              groupId: 'g1',
              modifierId: 'm1',
              name: 'Oat milk',
              priceDeltaC: 2500,
            },
            {
              groupId: 'g2',
              modifierId: 'm2',
              name: 'Extra shot',
              priceDeltaC: 1750,
            },
          ],
        },
        {
          qty: 1,
          unitPriceC: 9900,
          modifiers: [
            { groupId: 'g2', modifierId: 'm3', name: 'Decaf', priceDeltaC: 0 },
          ],
        },
      ],
    });

    const overview = await get(t.token, 'analytics/overview').expect(200);
    expect(overview.body.grossSalesC.value).toBe(sale.subtotal);

    // And the naive reading — which is what a missing lateral join produces.
    const naive = Math.round(2.5 * 13300) + 1 * 9900;
    expect(overview.body.grossSalesC.value).toBeGreaterThan(naive);
  });

  it('agrees between the overview, the heatmap and the trend for one range', async () => {
    const t = await seedTenant();
    const common = {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
    };
    await seedSale(raw, {
      ...common,
      lines: [
        {
          qty: 1,
          unitPriceC: 25000,
          discount: { source: 'free', kind: 'percent', value: 10 },
        },
      ],
    });
    await seedSale(raw, { ...common, lines: [{ qty: 3, unitPriceC: 4999 }] });

    const [overview, heatmap, trend] = await Promise.all([
      get(t.token, 'analytics/overview').expect(200),
      get(t.token, 'analytics/sales/heatmap').expect(200),
      get(t.token, 'analytics/sales/trend', { granularity: 'day' }).expect(200),
    ]);

    const net = overview.body.netSalesC.value;
    const heatmapTotal = heatmap.body.reduce(
      (n: number, d: any) => n + d.salesC,
      0,
    );
    const trendTotal = trend.body.reduce(
      (n: number, b: any) => n + b.salesC,
      0,
    );

    expect(heatmapTotal).toBe(net);
    expect(trendTotal).toBe(net);
  });

  it('agrees between the tax summary and the overview on service charge', async () => {
    const t = await seedTenant({ serviceChargeRate: '0.10' });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      orderType: 'dine_in',
      serviceChargeRate: 0.1,
      lines: [{ qty: 1, unitPriceC: 20000 }],
    });

    const [overview, tax] = await Promise.all([
      get(t.token, 'analytics/overview').expect(200),
      get(t.token, 'analytics/tax').expect(200),
    ]);

    expect(tax.body.totals.serviceChargeC).toBe(
      overview.body.serviceChargeC.value,
    );
  });

  it('never reports a zero margin for an uncosted catalogue, on any report', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 4, unitPriceC: 7500, costC: null }],
    });

    const [overview, trend] = await Promise.all([
      get(t.token, 'analytics/overview').expect(200),
      get(t.token, 'analytics/sales/trend', { granularity: 'day' }).expect(200),
    ]);

    expect(overview.body.grossProfitC.value).toBeNull();
    expect(overview.body.marginPct.value).toBeNull();
    for (const bucket of trend.body) {
      expect(bucket.grossProfitC).toBeNull();
    }
  });

  it('rounds a weight quantity per line, the way the engine does', async () => {
    const t = await seedTenant();
    // 1.335 kg at 99.99 — the engine rounds the line, not the total.
    const sale = await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1.335, unitPriceC: 9999 }],
    });

    const overview = await get(t.token, 'analytics/overview').expect(200);
    expect(overview.body.grossSalesC.value).toBe(sale.subtotal);
  });
});
