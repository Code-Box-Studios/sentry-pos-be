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
import { randomUUID } from 'crypto';
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

  const adjust = (token: string, branchId: string, body: object) =>
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

  const post = (token: string, branch: string, path: string, body: object) =>
    request(server())
      .post(`/v1/portal/branches/${branch}/stock/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (token: string, branch: string, path: string) =>
    request(server())
      .get(`/v1/portal/branches/${branch}/stock/${path}`)
      .set('Authorization', `Bearer ${token}`);
  async function setup() {
    const c = await ctx();
    const p = await makeProduct(c.token, c.businessId, c.categoryId, {
      costC: 250,
    });
    const b = await raw.branch.create({
      data: {
        businessId: c.businessId,
        name: 'Other',
        code: 'OT',
        address: 'x',
      },
    });
    await receive(c.token, c.branchId, [{ productId: p.id, qty: 5 }]).expect(
      201,
    );
    return { ...c, p, to: b.id };
  }
  it('transfers atomically and replays a concurrent client UUID once with history', async () => {
    const c = await setup();
    const id = randomUUID();
    const body = {
      id,
      toBranchId: c.to,
      lines: [{ productId: c.p.id, qty: 2 }],
      note: 'Restock',
    };
    const results = await Promise.all([
      post(c.token, c.branchId, 'transfers', body),
      post(c.token, c.branchId, 'transfers', body),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body).toEqual(results[1].body);
    expect(
      (
        await raw.branchStock.findFirstOrThrow({
          where: { branchId: c.branchId },
        })
      ).qty.toNumber(),
    ).toBe(3);
    expect(
      (
        await raw.branchStock.findFirstOrThrow({ where: { branchId: c.to } })
      ).qty.toNumber(),
    ).toBe(2);
    expect(await raw.stockMovement.count({ where: { transferId: id } })).toBe(
      2,
    );
    expect((await get(c.token, c.to, 'transfers').expect(200)).body[0].id).toBe(
      id,
    );
  });
  it('rejects overdraw and tenant crossing without partial writes', async () => {
    const c = await setup();
    const other = await ctx();
    await post(c.token, c.branchId, 'transfers', {
      id: randomUUID(),
      toBranchId: other.branchId,
      lines: [{ productId: c.p.id, qty: 2 }],
    }).expect(404);
    const results = await Promise.all(
      [1, 2].map(() =>
        post(c.token, c.branchId, 'transfers', {
          id: randomUUID(),
          toBranchId: c.to,
          lines: [{ productId: c.p.id, qty: 4 }],
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(
      (
        await raw.branchStock.findFirstOrThrow({
          where: { branchId: c.branchId },
        })
      ).qty.toNumber(),
    ).toBe(1);
    expect(
      await raw.stockMovement.count({ where: { type: 'transfer_out' } }),
    ).toBe(1);
  });
  it('posts a draft count exactly once using stock at posting and immutable variance history', async () => {
    const c = await setup();
    const id = randomUUID();
    const body = {
      id,
      notes: 'Shelf',
      items: [{ productId: c.p.id, countedQty: 3 }],
    };
    await post(c.token, c.branchId, 'counts', body).expect(201);
    await post(c.token, c.branchId, 'counts', body).expect(201);
    await receive(c.token, c.branchId, [{ productId: c.p.id, qty: 2 }]).expect(
      201,
    );
    const r = await Promise.all(
      [1, 2].map(() => post(c.token, c.branchId, `counts/${id}/post`, {})),
    );
    expect(r.map((x) => x.status)).toEqual([201, 201]);
    expect(r[0].body).toEqual(r[1].body);
    expect(r[0].body.items[0]).toMatchObject({
      expectedQty: 7,
      countedQty: 3,
      variance: -4,
    });
    expect(await raw.stockMovement.count({ where: { refId: id } })).toBe(1);
    expect(
      (await get(c.token, c.branchId, 'counts').expect(200)).body[0].status,
    ).toBe('posted');
    await request(server())
      .put(`/v1/portal/branches/${c.branchId}/stock/counts/${id}`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ items: [{ productId: c.p.id, countedQty: 0 }] })
      .expect(422);
  });
  it('captures branch expiry and derives FEFO remainder without mutating received batches', async () => {
    const c = await ctx();
    const p = await makeProduct(c.token, c.businessId, c.categoryId, {
      trackExpiry: true,
    });
    const expiryDate = new Date(Date.now() + 86400000).toISOString();
    const later = new Date(Date.now() + 2 * 86400000).toISOString();
    const id = randomUUID();
    const body = {
      id,
      lines: [{ productId: p.id, qty: 4, expiryDate, unitCostC: 125 }],
    };
    await post(c.token, c.branchId, 'receive', body).expect(201);
    await post(c.token, c.branchId, 'receive', body).expect(201);
    await receive(c.token, c.branchId, [
      { productId: p.id, qty: 3, expiryDate: later },
    ]).expect(201);
    await adjust(c.token, c.branchId, {
      productId: p.id,
      newQty: 5,
      reasonCategory: 'count_correction',
    }).expect(201);
    const report = await get(c.token, c.branchId, 'expiry').expect(200);
    expect(report.body.batches.map((b: any) => b.remainingQty)).toEqual([2, 3]);
    expect(await raw.stockBatch.count()).toBe(2);
    const other = await ctx();
    await get(other.token, c.branchId, 'expiry').expect(404);
  });
  it('returns a zero-shaped implicit analytics overview for an owner without real businesses', async () => {
    const { token } = await ownerToken();
    await request(server())
      .get('/v1/portal/analytics/overview?from=2026-09-01&to=2026-09-15')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
  it('draft edits validate variant-only stock, replace items, and stay inside branch scope', async () => {
    const c = await setup();
    const id = randomUUID();
    const v = await makeProduct(c.token, c.businessId, c.categoryId, {
      variants: [{ name: 'Small', priceC: 100, costC: 35 }],
    });
    await post(c.token, c.branchId, 'counts', {
      id,
      items: [{ productId: v.id, countedQty: 2 }],
    }).expect(422);
    await post(c.token, c.branchId, 'counts', {
      id,
      items: [{ productId: v.id, variantId: v.variants[0].id, countedQty: 2 }],
    }).expect(201);
    await get(c.token, c.to, `counts/${id}`).expect(404);
    const edited = await request(server())
      .put(`/v1/portal/branches/${c.branchId}/stock/counts/${id}`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ items: [{ productId: c.p.id, countedQty: 1 }], notes: 'Edited' })
      .expect(200);
    expect(edited.body.items).toHaveLength(1);
    expect(edited.body.items[0].productId).toBe(c.p.id);
    await post(c.token, c.branchId, `counts/${id}/post`, {}).expect(201);
    const movement = await raw.stockMovement.findFirstOrThrow({
      where: { refId: id },
    });
    expect(movement.unitCost).toBe(250);
    expect(
      await raw.auditLog.count({
        where: { businessId: c.businessId, entityId: id },
      }),
    ).toBeGreaterThan(0);
  });
  it('parallel absolute adjustments preserve the movement ledger and nonnegative stock', async () => {
    const c = await setup();
    await Promise.all(
      [2, 4].map((newQty) =>
        adjust(c.token, c.branchId, {
          productId: c.p.id,
          newQty,
          reasonCategory: 'count_correction',
        }).expect(201),
      ),
    );
    const level = await raw.branchStock.findFirstOrThrow({
      where: { branchId: c.branchId, productId: c.p.id },
    });
    const total = await raw.stockMovement.aggregate({
      where: { branchId: c.branchId, productId: c.p.id },
      _sum: { qtyDelta: true },
    });
    expect(total._sum.qtyDelta?.toNumber()).toBe(level.qty.toNumber());
  });
  it('transfer moves derived expiring quantities into the destination branch', async () => {
    const c = await setup();
    const p = await makeProduct(c.token, c.businessId, c.categoryId, {
      trackExpiry: true,
    });
    const expiryDate = new Date(Date.now() + 86400000).toISOString();
    await receive(c.token, c.branchId, [
      { productId: p.id, qty: 4, expiryDate, unitCostC: 99 },
    ]).expect(201);
    await post(c.token, c.branchId, 'transfers', {
      id: randomUUID(),
      toBranchId: c.to,
      lines: [{ productId: p.id, qty: 2 }],
    }).expect(201);
    for (const branchId of [c.branchId, c.to]) {
      const r = await get(c.token, branchId, 'expiry').expect(200);
      expect(r.body.batches[0]).toMatchObject({
        remainingQty: 2,
        unitCostC: 99,
      });
    }
  });
  it('rejects changed payloads reused under transfer, count and receive UUIDs', async () => {
    const c = await setup();
    const id = randomUUID();
    const body = {
      id,
      toBranchId: c.to,
      lines: [{ productId: c.p.id, qty: 1 }],
    };
    await post(c.token, c.branchId, 'transfers', body).expect(201);
    await post(c.token, c.branchId, 'transfers', {
      ...body,
      lines: [{ productId: c.p.id, qty: 2 }],
    }).expect(422);
    const countId = randomUUID(),
      countBody = {
        id: countId,
        items: [{ productId: c.p.id, countedQty: 3 }],
        notes: 'Initial',
      };
    await post(c.token, c.branchId, 'counts', countBody).expect(201);
    await post(c.token, c.branchId, 'counts', {
      ...countBody,
      notes: 'Changed',
    }).expect(422);
    await request(server())
      .put(`/v1/portal/branches/${c.branchId}/stock/counts/${countId}`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ items: [{ productId: c.p.id, countedQty: 4 }], notes: 'Edited' })
      .expect(200);
    const replay = await post(c.token, c.branchId, 'counts', countBody).expect(
      201,
    );
    expect(replay.body.notes).toBe('Edited');
    const receiveId = randomUUID(),
      receiveBody = {
        id: receiveId,
        lines: [{ productId: c.p.id, qty: 1, unitCostC: 50 }],
      };
    await post(c.token, c.branchId, 'receive', receiveBody).expect(201);
    await post(c.token, c.branchId, 'receive', {
      ...receiveBody,
      lines: [{ productId: c.p.id, qty: 1, unitCostC: 60 }],
    }).expect(422);
  });
  it('keeps transfer histories separate when an owner reuses a UUID in another business', async () => {
    const c = await setup();
    const original = await raw.business.findUniqueOrThrow({
      where: { id: c.businessId },
    });
    const b = await raw.business.create({
      data: {
        ownerId: original.ownerId,
        name: 'Second',
        type: 'retail',
        taxRate: 0.12,
      },
    });
    const category = await raw.category.create({
      data: { businessId: b.id, name: 'Other' },
    });
    const p = await raw.product.create({
      data: {
        businessId: b.id,
        categoryId: category.id,
        name: 'Second product',
        price: 100,
        trackStock: true,
      },
    });
    const from = await raw.branch.create({
        data: { businessId: b.id, name: 'From', code: 'F', address: 'x' },
      }),
      to = await raw.branch.create({
        data: { businessId: b.id, name: 'To', code: 'T', address: 'x' },
      });
    await receive(c.token, from.id, [{ productId: p.id, qty: 5 }]).expect(201);
    const id = randomUUID();
    await post(c.token, c.branchId, 'transfers', {
      id,
      toBranchId: c.to,
      lines: [{ productId: c.p.id, qty: 1 }],
    }).expect(201);
    await post(c.token, from.id, 'transfers', {
      id,
      toBranchId: to.id,
      lines: [{ productId: p.id, qty: 2 }],
    }).expect(201);
    const first = await get(c.token, c.branchId, 'transfers').expect(200),
      second = await get(c.token, from.id, 'transfers').expect(200);
    expect(first.body[0].lines).toHaveLength(1);
    expect(first.body[0].lines[0].productId).toBe(c.p.id);
    expect(second.body[0]).toMatchObject({
      fromBranchId: from.id,
      toBranchId: to.id,
      lines: [{ productId: p.id, qty: 2 }],
    });
  });
});
