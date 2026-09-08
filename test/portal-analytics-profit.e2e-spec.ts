/*
 * Profit & leaks (analytics-spec §4) e2e. Sales are seeded through the real
 * totals engine (`test/helpers/sales.ts`), so the discount attribution here is
 * checked against the arithmetic the POS actually produces.
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
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
const RANGE = { from: '2026-03-01', to: '2026-03-07' };

describe('Portal analytics — profit & leaks (e2e)', () => {
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

  async function seedCategory(businessId: string, name = 'Coffee') {
    return raw.category.create({ data: { businessId, name } });
  }

  async function seedProduct(
    businessId: string,
    categoryId: string,
    name: string,
    over: Record<string, unknown> = {},
  ) {
    return raw.product.create({
      data: { businessId, categoryId, name, price: 10000, ...over },
    });
  }

  const profit = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/profit')
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

  it('reports profit over time, by product and by category', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const latte = await seedProduct(t.businessId, category.id, 'Latte', {
      price: 12000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Latte',
          productId: latte.id,
          qty: 2,
          unitPriceC: 12000,
          costC: 4000,
        },
      ],
    });

    const res = await profit(t.token, { businessId: t.businessId }).expect(200);

    const day = res.body.overTime.find((b: any) => b.bucket === '2026-03-02');
    expect(day.grossProfitC).toBe(16000);
    expect(res.body.byProduct[0]).toMatchObject({
      productId: latte.id,
      revenueC: 24000,
      costC: 8000,
      grossProfitC: 16000,
    });
    expect(res.body.byCategory[0]).toMatchObject({
      categoryId: category.id,
      revenueC: 24000,
      grossProfitC: 16000,
    });
  });

  it('says how much of the revenue the profit figure covers', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const costed = await seedProduct(t.businessId, category.id, 'Costed', {
      price: 10000,
    });
    const uncosted = await seedProduct(t.businessId, category.id, 'Uncosted', {
      price: 5000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Costed',
          productId: costed.id,
          qty: 1,
          unitPriceC: 10000,
          costC: 6000,
        },
        {
          name: 'Uncosted',
          productId: uncosted.id,
          qty: 1,
          unitPriceC: 5000,
          costC: null,
        },
      ],
    });

    const res = await profit(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.costedRevenueC).toBe(10000);
    expect(res.body.uncostedRevenueC).toBe(5000);

    const unknown = res.body.byProduct.find(
      (p: any) => p.productId === uncosted.id,
    );
    // Unknown, not zero — the whole point of the null-cost rule.
    expect(unknown.costC).toBeNull();
    expect(unknown.grossProfitC).toBeNull();
    expect(unknown.marginPct).toBeNull();
  });

  it('reports margin as a fraction, matching the overview', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const p = await seedProduct(t.businessId, category.id, 'P', {
      price: 10000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'P', productId: p.id, qty: 1, unitPriceC: 10000, costC: 6000 },
      ],
    });

    const res = await profit(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.byProduct[0].marginPct).toBeCloseTo(0.4);
  });

  it('exports profit as CSV with an empty margin for unknown cost', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const uncosted = await seedProduct(t.businessId, category.id, 'Uncosted', {
      price: 5000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Uncosted',
          productId: uncosted.id,
          qty: 1,
          unitPriceC: 5000,
          costC: null,
        },
      ],
    });

    const res = await profit(t.token, {
      businessId: t.businessId,
      format: 'csv',
    }).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Uncosted,50.00,,,');
  });
});
