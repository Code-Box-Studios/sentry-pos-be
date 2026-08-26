/*
 * Task 17 — POS catalog pull e2e (TDD).
 *
 * The owner builds a catalog via the portal API (so cost IS stored), then a
 * paired terminal pulls GET /v1/pos/catalog (TerminalGuard). Asserts the FE
 * CatalogPayload shape, that cost is excluded from EVERY product/variant JSON,
 * that only active products + active discounts appear, and that stock comes from
 * StockService.levels.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

let seq = 0;

describe('POS catalog pull (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  async function ownerToken() {
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
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    return { owner, token: accessToken };
  }

  /** Pair a terminal for a branch (seed the device token directly) — returns the raw token. */
  async function seedTerminal(branchId: string): Promise<string> {
    const deviceToken = randomBytes(32).toString('hex');
    await raw.terminal.create({
      data: {
        branchId,
        name: 'Register 1',
        code: 'T1',
        deviceTokenHash: sha256(deviceToken),
      },
    });
    return deviceToken;
  }

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

  /** Build a full catalog via the portal API. Returns ids + the device token. */
  async function buildCatalog() {
    const { token } = await ownerToken();
    const post = (url: string, body: object) =>
      request(server())
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    const biz = await post('/v1/portal/businesses', {
      name: 'Kape',
      type: 'fnb',
      currency: 'PHP',
      taxRate: 0.12,
      serviceChargeRate: 0.05,
    }).expect(201);
    const businessId = biz.body.id;
    const branch = await post(`/v1/portal/businesses/${businessId}/branches`, {
      name: 'Main',
      code: 'MN',
      address: '123 St',
    }).expect(201);
    const branchId = branch.body.id;
    const cat = await post(`/v1/portal/businesses/${businessId}/categories`, {
      name: 'Coffee',
      sortOrder: 1,
    }).expect(201);

    // A modifier group to link.
    const mg = await post(
      `/v1/portal/businesses/${businessId}/modifier-groups`,
      {
        name: 'Milk',
        minSelect: 0,
        maxSelect: 1,
        modifiers: [{ name: 'Oat', priceDeltaC: 2500 }],
      },
    ).expect(201);

    // Active plain product with a COST — linked to the group; stocked.
    const p1 = await post(`/v1/portal/businesses/${businessId}/products`, {
      categoryId: cat.body.id,
      name: 'Espresso',
      sku: 'CF-1',
      priceC: 8500,
      costC: 5000,
      trackStock: true,
    }).expect(201);
    await request(server())
      .put(`/v1/portal/products/${p1.body.id}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send({ groupIds: [mg.body.id] })
      .expect(200);

    // Active product WITH a variant carrying a cost.
    const p3 = await post(`/v1/portal/businesses/${businessId}/products`, {
      categoryId: cat.body.id,
      name: 'Latte',
      priceC: 12000,
      variants: [{ name: 'Large', priceC: 14000, costC: 6000 }],
    }).expect(201);

    // Inactive product — must be EXCLUDED.
    await post(`/v1/portal/businesses/${businessId}/products`, {
      categoryId: cat.body.id,
      name: 'Discontinued',
      priceC: 100,
      active: false,
    }).expect(201);

    // Active + inactive discount.
    await post(`/v1/portal/businesses/${businessId}/discounts`, {
      name: 'Merienda 10%',
      kind: 'percent',
      value: 10,
      appliesTo: 'both',
    }).expect(201);
    await post(`/v1/portal/businesses/${businessId}/discounts`, {
      name: 'Old promo',
      kind: 'fixed',
      value: 2000,
      appliesTo: 'order',
      active: false,
    }).expect(201);

    // Receive stock for p1.
    await post(`/v1/portal/branches/${branchId}/stock/receive`, {
      lines: [{ productId: p1.body.id, qty: 9, unitCostC: 5000 }],
    }).expect(201);

    const deviceToken = await seedTerminal(branchId);
    return {
      deviceToken,
      businessId,
      branchId,
      categoryId: cat.body.id,
      p1Id: p1.body.id,
      p3Id: p3.body.id,
      mgId: mg.body.id,
    };
  }

  const pull = (deviceToken: string) =>
    request(server())
      .get('/v1/pos/catalog')
      .set('Authorization', `Bearer ${deviceToken}`);

  it('rejects an unpaired/unknown device token (401)', async () => {
    await pull('nope').expect(401);
    await request(server()).get('/v1/pos/catalog').expect(401);
  });

  it('returns the FE CatalogPayload shape', async () => {
    const c = await buildCatalog();
    const res = await pull(c.deviceToken).expect(200);
    const b = res.body;

    expect(b.business.id).toBe(c.businessId);
    expect(b.business.taxRate).toBe(0.12);
    expect(b.business.serviceChargeRate).toBe(0.05);
    expect(b.business.currency).toBe('PHP');
    expect(b.business.expiryWarningDays).toBeUndefined(); // not in FE BusinessSettings

    expect(b.branch).toEqual({
      id: c.branchId,
      name: 'Main',
      code: 'MN',
      address: '123 St',
    });
    expect(b.terminal).toEqual({ name: 'Register 1', code: 'T1' });
    expect(b.categories.map((x: any) => x.id)).toContain(c.categoryId);
    expect(typeof b.loadedAt).toBe('string');
    expect(Array.isArray(b.stock)).toBe(true);
  });

  it('excludes cost from every product and variant', async () => {
    const c = await buildCatalog();
    const res = await pull(c.deviceToken).expect(200);

    // The single strongest check: no cost key anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toContain('"cost"');

    const p1 = res.body.products.find((p: any) => p.id === c.p1Id);
    expect(p1.priceC).toBe(8500);
    expect(p1).not.toHaveProperty('cost');
    expect(p1).not.toHaveProperty('costC');
    expect(p1.modifierGroupIds).toEqual([c.mgId]);

    const p3 = res.body.products.find((p: any) => p.id === c.p3Id);
    expect(p3.variants).toHaveLength(1);
    expect(p3.variants[0].priceC).toBe(14000);
    expect(p3.variants[0]).not.toHaveProperty('cost');
    expect(p3.variants[0]).not.toHaveProperty('costC');
  });

  it('includes only active products and active discounts', async () => {
    const c = await buildCatalog();
    const res = await pull(c.deviceToken).expect(200);

    const names = res.body.products.map((p: any) => p.name);
    expect(names).toContain('Espresso');
    expect(names).toContain('Latte');
    expect(names).not.toContain('Discontinued'); // inactive excluded
    expect(res.body.products.every((p: any) => p.active === true)).toBe(true);

    const discNames = res.body.discounts.map((d: any) => d.name);
    expect(discNames).toContain('Merienda 10%');
    expect(discNames).not.toContain('Old promo'); // inactive excluded
    expect(res.body.discounts.every((d: any) => d.active === true)).toBe(true);
  });

  it('includes modifier groups and stock levels (productId/variantId/qty only)', async () => {
    const c = await buildCatalog();
    const res = await pull(c.deviceToken).expect(200);

    const mg = res.body.modifierGroups.find((g: any) => g.id === c.mgId);
    expect(mg.name).toBe('Milk');
    expect(mg.modifiers[0].priceDeltaC).toBe(2500);

    const level = res.body.stock.find((s: any) => s.productId === c.p1Id);
    expect(level).toEqual({ productId: c.p1Id, variantId: null, qty: 9 });
  });
});
