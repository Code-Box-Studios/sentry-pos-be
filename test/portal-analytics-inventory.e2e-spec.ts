/*
 * Inventory movements, shrinkage and stock on hand (analytics-spec §5) e2e.
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

const DURING = new Date('2026-03-02T02:00:00.000Z');
const RANGE = { from: '2026-03-01', to: '2026-03-07' };

describe('Portal analytics — inventory (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  const server = () => app.getHttpServer();

  async function seedTenant() {
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
      data: { ownerId: owner.id, name: 'B', type: 'retail', taxRate: '0.12' },
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

  async function seedProduct(
    businessId: string,
    over: Record<string, unknown> = {},
  ) {
    const category = await raw.category.create({
      data: { businessId, name: `C-${Math.random()}` },
    });
    return raw.product.create({
      data: {
        businessId,
        categoryId: category.id,
        name: 'Rice',
        price: 5000,
        cost: 3000,
        ...over,
      },
    });
  }

  const get = (
    token: string,
    path: string,
    query: Record<string, string> = {},
  ) =>
    request(server())
      .get(`/v1/portal/analytics/inventory/${path}`)
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

  // ---------------------------------------------------------------- movements

  it('lists movements newest first with product and branch names', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.stockMovement.createMany({
      data: [
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'receive',
          refId: product.id,
          qtyDelta: '10',
          unitCost: 3000,
          createdAt: new Date('2026-03-02T01:00:00.000Z'),
        },
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'adjustment',
          refId: product.id,
          qtyDelta: '-2',
          reasonCategory: 'damage',
          note: 'Dropped a sack',
          createdAt: new Date('2026-03-02T03:00:00.000Z'),
        },
      ],
    });

    const res = await get(t.token, 'movements', {
      businessId: t.businessId,
    }).expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.data[0]).toMatchObject({
      type: 'adjustment',
      qtyDelta: -2,
      reasonCategory: 'damage',
      note: 'Dropped a sack',
      productName: 'Rice',
      branchName: 'Main',
    });
    expect(res.body.data[1].type).toBe('receive');
  });

  it('filters by movement type and by product', async () => {
    const t = await seedTenant();
    const rice = await seedProduct(t.businessId);
    const beans = await seedProduct(t.businessId, { name: 'Beans' });
    await raw.stockMovement.createMany({
      data: [
        {
          branchId: t.branchId,
          productId: rice.id,
          type: 'receive',
          refId: rice.id,
          qtyDelta: '5',
          createdAt: DURING,
        },
        {
          branchId: t.branchId,
          productId: beans.id,
          type: 'adjustment',
          refId: beans.id,
          qtyDelta: '-1',
          createdAt: DURING,
        },
      ],
    });

    const byType = await get(t.token, 'movements', {
      businessId: t.businessId,
      type: 'receive',
    }).expect(200);
    expect(byType.body.total).toBe(1);

    const byProduct = await get(t.token, 'movements', {
      businessId: t.businessId,
      productId: beans.id,
    }).expect(200);
    expect(byProduct.body.total).toBe(1);
    expect(byProduct.body.data[0].productName).toBe('Beans');
  });

  it('paginates', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.stockMovement.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        branchId: t.branchId,
        productId: product.id,
        type: 'receive' as const,
        refId: product.id,
        qtyDelta: '1',
        createdAt: new Date(`2026-03-02T0${i}:00:00.000Z`),
      })),
    });

    const res = await get(t.token, 'movements', {
      businessId: t.businessId,
      pageSize: '2',
      page: '2',
    }).expect(200);

    expect(res.body).toMatchObject({
      page: 2,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });
    expect(res.body.data).toHaveLength(2);
  });

  it('surfaces who and why from the audit trail when a row exists', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    const movement = await raw.stockMovement.create({
      data: {
        branchId: t.branchId,
        productId: product.id,
        type: 'adjustment',
        refId: product.id,
        qtyDelta: '-1',
        reasonCategory: 'theft_loss',
        createdAt: DURING,
      },
    });
    await raw.auditLog.create({
      data: {
        actorType: 'owner',
        actorId: t.ownerId,
        ownerId: t.ownerId,
        businessId: t.businessId,
        branchId: t.branchId,
        action: 'stock.adjust',
        entityType: 'stock_movement',
        entityId: movement.id,
        changes: {},
        metadata: {},
      },
    });

    const res = await get(t.token, 'movements', {
      businessId: t.businessId,
    }).expect(200);
    expect(res.body.data[0].actor).toMatchObject({
      actorType: 'owner',
      action: 'stock.adjust',
    });
  });

  it('reports a null actor rather than inventing one when no audit row matches', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.stockMovement.create({
      data: {
        branchId: t.branchId,
        productId: product.id,
        type: 'receive',
        refId: product.id,
        qtyDelta: '1',
        createdAt: DURING,
      },
    });

    const res = await get(t.token, 'movements', {
      businessId: t.businessId,
    }).expect(200);
    expect(res.body.data[0].actor).toBeNull();
  });

  it('rejects a page beyond the merge bound with 422', async () => {
    const t = await seedTenant();
    await get(t.token, 'movements', {
      businessId: t.businessId,
      pageSize: '200',
      page: '20',
    }).expect(422);
  });

  it('rejects an unknown movement type with 422', async () => {
    const t = await seedTenant();
    await get(t.token, 'movements', {
      businessId: t.businessId,
      type: 'teleport',
    }).expect(422);
  });

  // ---------------------------------------------------------------- shrinkage

  it('splits adjustment losses by reason and values them at cost', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: 3000 });
    await raw.stockMovement.createMany({
      data: [
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'adjustment',
          refId: product.id,
          qtyDelta: '-2',
          reasonCategory: 'damage',
          createdAt: DURING,
        },
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'adjustment',
          refId: product.id,
          qtyDelta: '-1',
          reasonCategory: 'expiry',
          createdAt: DURING,
        },
      ],
    });

    const res = await get(t.token, 'shrinkage', {
      businessId: t.businessId,
    }).expect(200);

    const damage = res.body.rows.find(
      (r: any) => r.reasonCategory === 'damage',
    );
    expect(damage).toMatchObject({ units: 2, valueC: 6000, uncostedUnits: 0 });
    expect(
      res.body.rows.find((r: any) => r.reasonCategory === 'expiry').valueC,
    ).toBe(3000);
  });

  it('counts uncosted units instead of valuing them at zero', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: null });
    await raw.stockMovement.create({
      data: {
        branchId: t.branchId,
        productId: product.id,
        type: 'adjustment',
        refId: product.id,
        qtyDelta: '-4',
        reasonCategory: 'theft_loss',
        createdAt: DURING,
      },
    });

    const res = await get(t.token, 'shrinkage', {
      businessId: t.businessId,
    }).expect(200);

    const row = res.body.rows[0];
    expect(row).toMatchObject({
      reasonCategory: 'theft_loss',
      units: 4,
      uncostedUnits: 4,
    });
    // Unknown value, not zero value.
    expect(row.valueC).toBeNull();
  });

  it('ignores positive adjustments, receives and sales', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.stockMovement.createMany({
      data: [
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'adjustment',
          refId: product.id,
          qtyDelta: '5',
          reasonCategory: 'count_correction',
          createdAt: DURING,
        },
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'receive',
          refId: product.id,
          qtyDelta: '10',
          createdAt: DURING,
        },
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'sale',
          refId: product.id,
          qtyDelta: '-3',
          createdAt: DURING,
        },
      ],
    });

    const res = await get(t.token, 'shrinkage', {
      businessId: t.businessId,
    }).expect(200);
    expect(res.body.rows).toEqual([]);
  });

  it('prefers a variant cost over the parent cost', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: 3000 });
    const variant = await raw.productVariant.create({
      data: { productId: product.id, name: 'Large', price: 8000, cost: 5000 },
    });
    await raw.stockMovement.create({
      data: {
        branchId: t.branchId,
        productId: product.id,
        variantId: variant.id,
        type: 'adjustment',
        refId: product.id,
        qtyDelta: '-2',
        reasonCategory: 'damage',
        createdAt: DURING,
      },
    });

    const res = await get(t.token, 'shrinkage', {
      businessId: t.businessId,
    }).expect(200);
    expect(res.body.rows[0].valueC).toBe(10000);
  });

  // ------------------------------------------------------------------ on hand

  it('reports quantity, valuation and the low-stock flag', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, {
      cost: 3000,
      lowStockThreshold: '10',
    });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '4' },
    });

    const res = await get(t.token, 'on-hand', {
      businessId: t.businessId,
    }).expect(200);

    expect(res.body.rows[0]).toMatchObject({
      productId: product.id,
      name: 'Rice',
      qty: 4,
      unitCostC: 3000,
      valueC: 12000,
      lowStockThreshold: 10,
      isLow: true,
    });
    expect(res.body.totals).toMatchObject({ valueC: 12000, uncostedItems: 0 });
  });

  it('counts uncosted stock rather than valuing it at zero', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: null });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '7' },
    });

    const res = await get(t.token, 'on-hand', {
      businessId: t.businessId,
    }).expect(200);

    expect(res.body.rows[0].valueC).toBeNull();
    expect(res.body.totals).toMatchObject({ valueC: 0, uncostedItems: 1 });
  });

  it('estimates days of stock from sales in the period', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '14' },
    });
    // 7 sold across a 7-day range = 1/day, so 14 on hand lasts 14 days.
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Rice', productId: product.id, qty: 7, unitPriceC: 5000 },
      ],
    });

    const res = await get(t.token, 'on-hand', {
      businessId: t.businessId,
    }).expect(200);
    expect(res.body.rows[0].daysOfStock).toBeCloseTo(14);
  });

  it('reports days of stock as null for something that never sold', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '14' },
    });

    const res = await get(t.token, 'on-hand', {
      businessId: t.businessId,
    }).expect(200);
    expect(res.body.rows[0].daysOfStock).toBeNull();
  });

  it('is not low when no threshold is set, however empty the shelf', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, {
      lowStockThreshold: null,
    });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '0' },
    });

    const res = await get(t.token, 'on-hand', {
      businessId: t.businessId,
    }).expect(200);
    expect(res.body.rows[0].isLow).toBe(false);
  });

  it('exports on-hand as CSV', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: 3000 });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '4' },
    });

    const res = await get(t.token, 'on-hand', {
      businessId: t.businessId,
      format: 'csv',
    }).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Main,Rice,4,30.00,120.00');
  });
});
