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

  const leaks = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/leaks')
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  it('attributes a named line discount to its name', async () => {
    const t = await seedTenant();
    const discount = await raw.discount.create({
      data: {
        businessId: t.businessId,
        name: 'Staff 10%',
        kind: 'percent',
        value: 10,
        appliesTo: 'line',
      },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Latte',
          qty: 1,
          unitPriceC: 10000,
          discount: {
            source: 'named',
            discountId: discount.id,
            name: 'Staff 10%',
            kind: 'percent',
            value: 10,
          },
        },
      ],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.discountsByName).toEqual([
      expect.objectContaining({
        discountId: discount.id,
        name: 'Staff 10%',
        timesUsed: 1,
        amountC: 1000,
      }),
    ]);
  });

  it('reports the order-level discount as the unattributed remainder', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Latte', qty: 1, unitPriceC: 10000 }],
      orderDiscount: { source: 'free', kind: 'fixed', value: 2500 },
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    // sales.discount carries line promos PLUS the order discount; there is no
    // line discount here, so the whole 2500 is order-level.
    expect(res.body.orderLevelDiscountC).toBe(2500);
  });

  it('does not double-count a line promo as an order discount', async () => {
    const t = await seedTenant();
    const discount = await raw.discount.create({
      data: {
        businessId: t.businessId,
        name: 'Staff 10%',
        kind: 'percent',
        value: 10,
        appliesTo: 'line',
      },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Latte',
          qty: 1,
          unitPriceC: 10000,
          discount: {
            source: 'named',
            discountId: discount.id,
            name: 'Staff 10%',
            kind: 'percent',
            value: 10,
          },
        },
      ],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.discountsByName[0].amountC).toBe(1000);
    expect(res.body.orderLevelDiscountC).toBe(0);
  });

  it('reports SC/PWD discount, VAT-exempt sales and the sale count', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      scPwd: { idNo: 'SC-1', name: 'Lola' },
      lines: [{ name: 'Meal', qty: 1, unitPriceC: 10000, scPwdMarked: true }],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.scPwd.saleCount).toBe(1);
    expect(res.body.scPwd.discountC).toBeGreaterThan(0);
    expect(res.body.scPwd.vatExemptSalesC).toBeGreaterThan(0);
  });

  it('reports misc rings as a share of net sales', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const latte = await seedProduct(t.businessId, category.id, 'Latte', {
      price: 7500,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        // A misc line is one with NO productId; the catalogue line must carry
        // one or it counts as misc too.
        { name: 'Open item', productId: null, qty: 1, unitPriceC: 2500 },
        { name: 'Latte', productId: latte.id, qty: 1, unitPriceC: 7500 },
      ],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.miscLines.revenueC).toBe(2500);
    // A FRACTION, like every other ratio in these reports.
    expect(res.body.miscLines.pctOfNetSales).toBeCloseTo(0.25);
  });

  it('ranks void and refund reasons by value', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      status: 'voided',
      statusReason: 'Wrong order',
      lines: [{ name: 'Latte', qty: 1, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      status: 'voided',
      statusReason: 'Customer left',
      lines: [{ name: 'Latte', qty: 5, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      status: 'refunded',
      statusReason: 'Spoiled',
      lines: [{ name: 'Latte', qty: 1, unitPriceC: 20000 }],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.voids.count).toBe(2);
    expect(res.body.voids.valueC).toBe(60000);
    expect(res.body.voids.reasons[0]).toMatchObject({
      reason: 'Customer left',
      valueC: 50000,
    });
    expect(res.body.refunds).toMatchObject({ count: 1, valueC: 20000 });
  });

  it('reports over/short per closed shift, negative meaning short', async () => {
    const t = await seedTenant();
    await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date('2026-03-02T00:00:00.000Z'),
        closedAt: new Date('2026-03-02T10:00:00.000Z'),
        openingCash: 100000,
        expectedCash: 150000,
        closingCash: 149500,
      },
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.overShort).toEqual([
      expect.objectContaining({
        branchName: 'Main',
        expectedCashC: 150000,
        closingCashC: 149500,
        varianceC: -500,
      }),
    ]);
  });

  it('leaves an open shift out of over/short', async () => {
    const t = await seedTenant();
    await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date('2026-03-02T00:00:00.000Z'),
        openingCash: 100000,
      },
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.overShort).toEqual([]);
  });

  it('reports zero and empty rather than failing on a quiet period', async () => {
    const t = await seedTenant();
    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.orderLevelDiscountC).toBe(0);
    expect(res.body.miscLines).toEqual({ revenueC: 0, pctOfNetSales: null });
    expect(res.body.voids).toEqual({ count: 0, valueC: 0, reasons: [] });
  });
});
