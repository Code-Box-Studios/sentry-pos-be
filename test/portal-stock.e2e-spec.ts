/*
 * Task 15 — Portal stock (receive / adjust / levels) e2e (TDD).
 *
 * Owner-role token (tenant scope via PortalAuthGuard). Exercises the shared
 * StockService via the portal endpoints: receive (levels + movements + latest
 * cost + expiry batches, grouped by one operation ref), adjust (absolute target,
 * reason, self-ref movement), variant-integrity rules, tenant isolation, and the
 * qty>=0 invariant under concurrent adjustments.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();

let seq = 0;

async function seedOwner() {
  seq += 1;
  const owner = await raw.owner.create({
    data: {
      name: `Owner ${seq}`,
      email: `owner-${seq}-${Date.now()}@test.com`,
      status: 'active',
      maxBusinesses: 5,
    },
  });
  const user = await raw.user.create({
    data: {
      email: `user-${seq}-${Date.now()}@test.com`,
      role: 'owner',
      ownerId: owner.id,
      passwordHash: 'x',
    },
  });
  return { owner, user };
}

describe('Portal stock (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  async function ownerToken() {
    const { owner, user } = await seedOwner();
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    return { owner, token: accessToken };
  }

  async function ctx() {
    const { token } = await ownerToken();
    const biz = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Biz', type: 'retail', currency: 'PHP', taxRate: 0.12 })
      .expect(201);
    const branch = await request(server())
      .post(`/v1/portal/businesses/${biz.body.id}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main', code: 'MN', address: 'x' })
      .expect(201);
    const cat = await request(server())
      .post(`/v1/portal/businesses/${biz.body.id}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Grocery' })
      .expect(201);
    return {
      token,
      businessId: biz.body.id,
      branchId: branch.body.id,
      categoryId: cat.body.id,
    };
  }

  async function makeProduct(
    token: string,
    businessId: string,
    categoryId: string,
    over: Record<string, unknown> = {},
  ): Promise<any> {
    const res = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        categoryId,
        name: `P-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        priceC: 10000,
        trackStock: true,
        ...over,
      })
      .expect(201);
    return res.body;
  }

  const receive = (token: string, branchId: string, lines: unknown[]) =>
    request(server())
      .post(`/v1/portal/branches/${branchId}/stock/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({ lines });

  const adjust = (token: string, branchId: string, body: unknown) =>
    request(server())
      .post(`/v1/portal/branches/${branchId}/stock/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

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

  const server = () => app.getHttpServer();

  // =========================================================================
  // Receive
  // =========================================================================

  it('receives stock: creates level + movement + latest cost, grouped by one ref', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p1 = await makeProduct(token, businessId, categoryId);
    const p2 = await makeProduct(token, businessId, categoryId);

    await receive(token, branchId, [
      { productId: p1.id, qty: 5, unitCostC: 4000 },
      { productId: p2.id, qty: 3, unitCostC: 2500 },
    ]).expect(201);

    const s1 = await raw.branchStock.findFirstOrThrow({
      where: { branchId, productId: p1.id, variantId: null },
    });
    expect(Number(s1.qty)).toBe(5);

    const moves = await raw.stockMovement.findMany({
      where: { branchId, type: 'receive' },
    });
    expect(moves.length).toBe(2);
    // Multi-line receive shares one operation ref.
    expect(new Set(moves.map((m) => m.refId)).size).toBe(1);
    expect(moves.every((m) => m.unitCost !== null)).toBe(true);

    // Latest-cost overwrite on the product.
    const prod1 = await raw.product.findUniqueOrThrow({ where: { id: p1.id } });
    expect(prod1.cost).toBe(4000);

    // Movement is auto-audited by the choke point.
    const audit = await raw.auditLog.findMany({
      where: { action: 'stockMovement.create' },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('accumulates qty across receives and updates cost to the latest', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId);

    await receive(token, branchId, [
      { productId: p.id, qty: 5, unitCostC: 4000 },
    ]).expect(201);
    await receive(token, branchId, [
      { productId: p.id, qty: 2, unitCostC: 4500 },
    ]).expect(201);

    const s = await raw.branchStock.findFirstOrThrow({
      where: { branchId, productId: p.id, variantId: null },
    });
    expect(Number(s.qty)).toBe(7);
    const prod = await raw.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(prod.cost).toBe(4500); // latest cost
  });

  it('updates the variant cost (not the product) when receiving a variant line', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId, {
      variants: [{ name: 'Large', priceC: 12000 }],
    });
    const variantId = p.variants[0].id;

    await receive(token, branchId, [
      { productId: p.id, variantId, qty: 4, unitCostC: 5000 },
    ]).expect(201);

    const variant = await raw.productVariant.findUniqueOrThrow({
      where: { id: variantId },
    });
    expect(variant.cost).toBe(5000);
    const s = await raw.branchStock.findFirstOrThrow({
      where: { branchId, productId: p.id, variantId },
    });
    expect(Number(s.qty)).toBe(4);
  });

  it('creates an expiry batch when receiving a track_expiry product', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId, {
      trackExpiry: true,
    });

    await receive(token, branchId, [
      { productId: p.id, qty: 6, unitCostC: 1000, expiryDate: '2027-01-01' },
    ]).expect(201);

    const batches = await raw.stockBatch.findMany({
      where: { productId: p.id },
    });
    expect(batches.length).toBe(1);
    expect(Number(batches[0].qty)).toBe(6);
    expect(batches[0].expiresAt).not.toBeNull();
  });

  // =========================================================================
  // Adjust
  // =========================================================================

  it('adjusts an absolute target from 0, recording reason + self-ref movement', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId);

    await adjust(token, branchId, {
      productId: p.id,
      newQty: 2,
      reasonCategory: 'count_correction',
      note: 'initial count',
    }).expect(201);

    const s = await raw.branchStock.findFirstOrThrow({
      where: { branchId, productId: p.id, variantId: null },
    });
    expect(Number(s.qty)).toBe(2);

    const mv = await raw.stockMovement.findFirstOrThrow({
      where: { branchId, productId: p.id, type: 'adjustment' },
    });
    expect(Number(mv.qtyDelta)).toBe(2);
    expect(mv.reasonCategory).toBe('count_correction');
    expect(mv.refId).toBe(mv.id); // self-referential
  });

  it('requires an expiryDate when receiving a track_expiry product (422)', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId, {
      trackExpiry: true,
    });
    await receive(token, branchId, [{ productId: p.id, qty: 3 }]).expect(422);
  });

  it('rolls back the whole receive when a later line is invalid', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p1 = await makeProduct(token, businessId, categoryId);

    await receive(token, branchId, [
      { productId: p1.id, qty: 5, unitCostC: 100 },
      { productId: '11111111-1111-4111-8111-111111111111', qty: 1 },
    ]).expect(422);

    // Atomic: line 1 must NOT have been written.
    const s = await raw.branchStock.findMany({
      where: { branchId, productId: p1.id },
    });
    expect(s.length).toBe(0);
    const moves = await raw.stockMovement.findMany({ where: { branchId } });
    expect(moves.length).toBe(0);
  });

  it('rejects a negative adjustment target (422)', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId);
    await adjust(token, branchId, {
      productId: p.id,
      newQty: -1,
      reasonCategory: 'damage',
    }).expect(422);
  });

  // =========================================================================
  // Variant-integrity rule
  // =========================================================================

  it('rejects receiving a variant product without a variantId (422)', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId, {
      variants: [{ name: 'Large', priceC: 12000 }],
    });
    await receive(token, branchId, [{ productId: p.id, qty: 1 }]).expect(422);
  });

  it('rejects receiving with a variantId from another product (422)', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const withVariant = await makeProduct(token, businessId, categoryId, {
      variants: [{ name: 'Large', priceC: 12000 }],
    });
    const plain = await makeProduct(token, businessId, categoryId);
    await receive(token, branchId, [
      { productId: plain.id, variantId: withVariant.variants[0].id, qty: 1 },
    ]).expect(422);
  });

  it('rejects a variantId on a product that has no variants (422)', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId);
    await receive(token, branchId, [
      {
        productId: p.id,
        variantId: '11111111-1111-4111-8111-111111111111',
        qty: 1,
      },
    ]).expect(422);
  });

  // =========================================================================
  // Levels + tenant isolation
  // =========================================================================

  it('lists stock levels for tracked products', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId);
    await receive(token, branchId, [
      { productId: p.id, qty: 9, unitCostC: 100 },
    ]).expect(201);

    const res = await request(server())
      .get(`/v1/portal/branches/${branchId}/stock`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const level = res.body.find((l: any) => l.productId === p.id);
    expect(level).toBeDefined();
    expect(level.qty).toBe(9);
  });

  it('does not let an owner receive/adjust/list on another owner’s branch (404, no rows)', async () => {
    const a = await ctx();
    const b = await ctx();
    const aProd = await makeProduct(a.token, a.businessId, a.categoryId);

    await receive(b.token, a.branchId, [
      { productId: aProd.id, qty: 1 },
    ]).expect(404);
    await adjust(b.token, a.branchId, {
      productId: aProd.id,
      newQty: 5,
      reasonCategory: 'other',
    }).expect(404);
    await request(server())
      .get(`/v1/portal/branches/${a.branchId}/stock`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);

    // No stray rows were written for A's branch.
    const moves = await raw.stockMovement.findMany({
      where: { branchId: a.branchId },
    });
    expect(moves.length).toBe(0);
  });

  // =========================================================================
  // qty>=0 invariant under concurrent adjustments
  // =========================================================================

  it('keeps qty>=0 under two parallel adjustments', async () => {
    const { token, branchId, businessId, categoryId } = await ctx();
    const p = await makeProduct(token, businessId, categoryId);
    await receive(token, branchId, [
      { productId: p.id, qty: 5, unitCostC: 100 },
    ]).expect(201);

    const results = await Promise.all([
      adjust(token, branchId, {
        productId: p.id,
        newQty: 1,
        reasonCategory: 'count_correction',
      }),
      adjust(token, branchId, {
        productId: p.id,
        newQty: 0,
        reasonCategory: 'count_correction',
      }),
    ]);
    for (const r of results) expect(r.status).toBe(201);

    const s = await raw.branchStock.findFirstOrThrow({
      where: { branchId, productId: p.id, variantId: null },
    });
    expect(Number(s.qty)).toBeGreaterThanOrEqual(0);
    expect([0, 1]).toContain(Number(s.qty));
  });
});
