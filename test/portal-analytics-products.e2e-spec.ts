/*
 * Products sold (analytics-spec §3) e2e. Sales are seeded through the real
 * totals engine (`test/helpers/sales.ts`), so revenue here is the same
 * arithmetic the POS produces — modifier prices included.
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

describe('Portal analytics — products (e2e)', () => {
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

  const top = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/products/top')
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  const slow = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/products/slow')
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

  it('ranks by units sold, adding modifier prices into revenue', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const latte = await seedProduct(t.businessId, category.id, 'Latte', {
      price: 12000,
    });
    const bun = await seedProduct(t.businessId, category.id, 'Bun', {
      price: 3000,
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
          modifiers: [
            {
              groupId: '11111111-1111-1111-1111-111111111111',
              modifierId: '22222222-2222-2222-2222-222222222222',
              name: 'Oat milk',
              priceDeltaC: 2000,
            },
          ],
        },
        {
          name: 'Bun',
          productId: bun.id,
          qty: 5,
          unitPriceC: 3000,
          costC: 1000,
        },
      ],
    });

    const res = await top(t.token, {
      businessId: t.businessId,
      by: 'units',
    }).expect(200);

    expect(res.body.rows[0]).toMatchObject({ productId: bun.id, units: 5 });
    const latteRow = res.body.rows.find((r: any) => r.productId === latte.id);
    // 2 x (12000 + 2000) = 28000, not 2 x 12000.
    expect(latteRow.revenueC).toBe(28000);
    expect(latteRow.grossProfitC).toBe(20000);
  });

  it('ranks by revenue when asked', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const latte = await seedProduct(t.businessId, category.id, 'Latte', {
      price: 12000,
    });
    const bun = await seedProduct(t.businessId, category.id, 'Bun', {
      price: 3000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: latte.id, qty: 2, unitPriceC: 12000 },
        { name: 'Bun', productId: bun.id, qty: 5, unitPriceC: 3000 },
      ],
    });

    const res = await top(t.token, {
      businessId: t.businessId,
      by: 'revenue',
    }).expect(200);
    expect(res.body.rows[0].productId).toBe(latte.id);
  });

  it('rolls up categories alongside the product rows', async () => {
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
        { name: 'Latte', productId: latte.id, qty: 2, unitPriceC: 12000 },
      ],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.categories).toEqual([
      expect.objectContaining({
        categoryId: category.id,
        name: 'Coffee',
        units: 2,
        revenueC: 24000,
      }),
    ]);
  });

  it('reports margin as null for an uncosted product, never zero', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const tea = await seedProduct(t.businessId, category.id, 'Tea', {
      price: 5000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Tea',
          productId: tea.id,
          qty: 1,
          unitPriceC: 5000,
          costC: null,
        },
      ],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows[0].grossProfitC).toBeNull();
    expect(res.body.rows[0].marginPct).toBeNull();
  });

  it('names a deleted product from the sale-time snapshot', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const gone = await seedProduct(t.businessId, category.id, 'Retired', {
      price: 5000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Retired blend', productId: gone.id, qty: 1, unitPriceC: 5000 },
      ],
    });
    await raw.product.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows[0].name).toBe('Retired blend');
  });

  it('reports each variant on its own row', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const latte = await seedProduct(t.businessId, category.id, 'Latte', {
      price: 12000,
    });
    const large = await raw.productVariant.create({
      data: { productId: latte.id, name: 'Large', price: 14000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: latte.id, qty: 1, unitPriceC: 12000 },
        {
          name: 'Latte — Large',
          productId: latte.id,
          variantId: large.id,
          qty: 1,
          unitPriceC: 14000,
        },
      ],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    const variantRow = res.body.rows.find((r: any) => r.variantId === large.id);
    expect(variantRow.revenueC).toBe(14000);
    expect(res.body.rows).toHaveLength(2);
  });

  it('leaves misc lines out of the product report entirely', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Open item', productId: null, qty: 1, unitPriceC: 9900 }],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows).toEqual([]);
  });

  it('excludes voided sales', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const latte = await seedProduct(t.businessId, category.id, 'Latte', {
      price: 12000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      status: 'voided',
      lines: [
        { name: 'Latte', productId: latte.id, qty: 3, unitPriceC: 12000 },
      ],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows).toEqual([]);
  });

  it('honours the limit', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    for (const name of ['A', 'B', 'C']) {
      const p = await seedProduct(t.businessId, category.id, name, {
        price: 5000,
      });
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: DURING,
        lines: [{ name, productId: p.id, qty: 1, unitPriceC: 5000 }],
      });
    }

    const res = await top(t.token, {
      businessId: t.businessId,
      limit: '2',
    }).expect(200);
    expect(res.body.rows).toHaveLength(2);
  });

  it('rejects a limit outside 1..100 with 422', async () => {
    const t = await seedTenant();
    await top(t.token, { businessId: t.businessId, limit: '0' }).expect(422);
    await top(t.token, { businessId: t.businessId, limit: '101' }).expect(422);
  });

  it('rejects an unknown sort key with 422', async () => {
    const t = await seedTenant();
    await top(t.token, { businessId: t.businessId, by: 'profit' }).expect(422);
  });

  it('lists the worst sellers and the products that sold nothing', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const sold = await seedProduct(t.businessId, category.id, 'Sold', {
      price: 5000,
    });
    const never = await seedProduct(t.businessId, category.id, 'Never', {
      price: 5000,
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Sold', productId: sold.id, qty: 1, unitPriceC: 5000 }],
    });

    const res = await slow(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.bottom[0].productId).toBe(sold.id);
    expect(res.body.zeroSales).toEqual([
      expect.objectContaining({
        productId: never.id,
        name: 'Never',
        categoryName: 'Coffee',
      }),
    ]);
  });

  it('leaves archived products out of the zero-sales list', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    await seedProduct(t.businessId, category.id, 'Archived', {
      price: 5000,
      active: false,
    });

    const res = await slow(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.zeroSales).toEqual([]);
  });

  it('exports as CSV', async () => {
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
        { name: 'Latte', productId: latte.id, qty: 2, unitPriceC: 12000 },
      ],
    });

    const res = await top(t.token, {
      businessId: t.businessId,
      format: 'csv',
    }).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Latte,2,240.00');
  });
  const trend = (
    token: string,
    productId: string,
    query: Record<string, string> = {},
  ) =>
    request(server())
      .get(`/v1/portal/analytics/products/${productId}/trend`)
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  it('reports one product units, revenue and margin per bucket', async () => {
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

    const res = await trend(t.token, latte.id, {
      businessId: t.businessId,
      granularity: 'day',
    }).expect(200);

    const day = res.body.buckets.find((b: any) => b.bucket === '2026-03-02');
    expect(day).toMatchObject({
      units: 2,
      revenueC: 24000,
      grossProfitC: 16000,
    });
    // Margins are FRACTIONS, matching overview.math.
    expect(day.marginPct).toBeCloseTo(16000 / 24000);
  });

  it('merges variants into the product trend', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const latte = await seedProduct(t.businessId, category.id, 'Latte', {
      price: 12000,
    });
    const large = await raw.productVariant.create({
      data: { productId: latte.id, name: 'Large', price: 14000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: latte.id, qty: 1, unitPriceC: 12000 },
        {
          name: 'Latte — Large',
          productId: latte.id,
          variantId: large.id,
          qty: 1,
          unitPriceC: 14000,
        },
      ],
    });

    const res = await trend(t.token, latte.id, {
      businessId: t.businessId,
      granularity: 'day',
    }).expect(200);

    const day = res.body.buckets.find((b: any) => b.bucket === '2026-03-02');
    expect(day).toMatchObject({ units: 2, revenueC: 26000 });
  });

  it('zero-fills days with no sales of that product', async () => {
    const t = await seedTenant();
    const category = await seedCategory(t.businessId);
    const latte = await seedProduct(t.businessId, category.id, 'Latte', {
      price: 12000,
    });

    const res = await trend(t.token, latte.id, {
      businessId: t.businessId,
      granularity: 'day',
    }).expect(200);

    expect(res.body.buckets).toHaveLength(7);
    expect(res.body.buckets[0]).toEqual({
      bucket: '2026-03-01',
      units: 0,
      revenueC: 0,
      grossProfitC: null,
      marginPct: null,
    });
  });

  it('404s for a product the caller does not own', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();
    const category = await seedCategory(theirs.businessId);
    const notMine = await seedProduct(theirs.businessId, category.id, 'X');

    await trend(mine.token, notMine.id, {
      businessId: mine.businessId,
    }).expect(404);
  });

  it('422s on a productId that is not a uuid', async () => {
    const t = await seedTenant();
    await trend(t.token, 'not-a-uuid', { businessId: t.businessId }).expect(
      422,
    );
  });
});
