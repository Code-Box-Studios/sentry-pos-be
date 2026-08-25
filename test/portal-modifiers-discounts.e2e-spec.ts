/*
 * Task 13 — Portal modifier groups, product↔group links, and discounts e2e (TDD).
 *
 * Owner-role token (tenant scope via PortalAuthGuard). Exercises: modifier-group
 * CRUD with a nested modifier replace-set, the product↔modifier-group link
 * replace-set (PUT groupIds, including re-linking a previously-removed group),
 * and named discount CRUD with percent-range validation.
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

const milkGroup = (over: Record<string, unknown> = {}) => ({
  name: 'Milk',
  minSelect: 0,
  maxSelect: 1,
  modifiers: [
    { name: 'Oat milk', priceDeltaC: 2500 },
    { name: 'Fresh milk', priceDeltaC: 0 },
  ],
  ...over,
});

describe('Portal modifiers + discounts (e2e)', () => {
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

  /** Owner + token + business + category + one product. */
  async function ctx() {
    const { token } = await ownerToken();
    const biz = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Biz', type: 'fnb', currency: 'PHP', taxRate: 0.12 })
      .expect(201);
    const businessId = biz.body.id;
    const cat = await request(server())
      .post(`/v1/portal/businesses/${businessId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Coffee' })
      .expect(201);
    const prod = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ categoryId: cat.body.id, name: 'Latte', priceC: 12000 })
      .expect(201);
    return {
      token,
      businessId,
      categoryId: cat.body.id,
      productId: prod.body.id,
    };
  }

  async function createGroup(
    token: string,
    businessId: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    const res = await request(server())
      .post(`/v1/portal/businesses/${businessId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    return res.body;
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

  // =========================================================================
  // Modifier groups + nested modifiers
  // =========================================================================

  it('creates a modifier group with modifiers (priceDeltaC) and audits it', async () => {
    const { token, businessId } = await ctx();
    const group = await createGroup(token, businessId, milkGroup());

    expect(group.name).toBe('Milk');
    expect(group.minSelect).toBe(0);
    expect(group.maxSelect).toBe(1);
    expect(group.modifiers).toHaveLength(2);
    const oat = group.modifiers.find((m: any) => m.name === 'Oat milk');
    expect(oat.priceDeltaC).toBe(2500);

    const audit = await raw.auditLog.findMany({
      where: { action: 'modifierGroup.create', entityId: group.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].actorType).toBe('owner');
  });

  it('lists modifier groups with their live modifiers', async () => {
    const { token, businessId } = await ctx();
    await createGroup(token, businessId, milkGroup());
    await createGroup(
      token,
      businessId,
      milkGroup({
        name: 'Add-ons',
        maxSelect: 3,
        modifiers: [
          { name: 'Extra shot', priceDeltaC: 3000 },
          { name: 'Vanilla', priceDeltaC: 1500 },
          { name: 'Less ice', priceDeltaC: 0 },
        ],
      }),
    );

    const list = await request(server())
      .get(`/v1/portal/businesses/${businessId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const names = list.body.map((g: any) => g.name).sort();
    expect(names).toEqual(['Add-ons', 'Milk']);
    const addons = list.body.find((g: any) => g.name === 'Add-ons');
    expect(addons.modifiers).toHaveLength(3);
  });

  it('replace-sets modifiers on PATCH (add / update / soft-delete)', async () => {
    const { token, businessId } = await ctx();
    const group = await createGroup(token, businessId, milkGroup());
    const oat = group.modifiers.find((m: any) => m.name === 'Oat milk');
    const fresh = group.modifiers.find((m: any) => m.name === 'Fresh milk');

    const patched = await request(server())
      .patch(`/v1/portal/modifier-groups/${group.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        maxSelect: 2,
        modifiers: [
          { id: oat.id, name: 'Oat milk', priceDeltaC: 3000 }, // update
          { name: 'Soy milk', priceDeltaC: 2000 }, // create; Fresh dropped
        ],
      })
      .expect(200);

    expect(patched.body.maxSelect).toBe(2);
    const names = patched.body.modifiers.map((m: any) => m.name).sort();
    expect(names).toEqual(['Oat milk', 'Soy milk']);
    const removed = await raw.modifier.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(removed.deletedAt).not.toBeNull();
  });

  it('soft-deletes all modifiers when PATCH sends an empty modifiers array', async () => {
    const { token, businessId } = await ctx();
    const group = await createGroup(token, businessId, milkGroup());

    const patched = await request(server())
      .patch(`/v1/portal/modifier-groups/${group.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ modifiers: [] })
      .expect(200);
    expect(patched.body.modifiers).toHaveLength(0);

    for (const m of group.modifiers) {
      const row = await raw.modifier.findUniqueOrThrow({ where: { id: m.id } });
      expect(row.deletedAt).not.toBeNull();
    }
  });

  it('rejects minSelect > maxSelect on create and on patch (422)', async () => {
    const { token, businessId } = await ctx();
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send(milkGroup({ minSelect: 2, maxSelect: 1 }))
      .expect(422);

    const group = await createGroup(token, businessId, milkGroup());
    await request(server())
      .patch(`/v1/portal/modifier-groups/${group.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ minSelect: 5 }) // > current maxSelect 1
      .expect(422);
  });

  it('soft-deletes a modifier group', async () => {
    const { token, businessId } = await ctx();
    const group = await createGroup(token, businessId, milkGroup());
    await request(server())
      .delete(`/v1/portal/modifier-groups/${group.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const list = await request(server())
      .get(`/v1/portal/businesses/${businessId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((g: any) => g.id)).not.toContain(group.id);
  });

  it('does not let an owner touch another owner’s modifier group', async () => {
    const a = await ctx();
    const b = await ctx();
    const group = await createGroup(a.token, a.businessId, milkGroup());
    await request(server())
      .patch(`/v1/portal/modifier-groups/${group.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'hijack' })
      .expect(404);
  });

  // =========================================================================
  // Product ↔ modifier-group links (replace-set, restore-aware)
  // =========================================================================

  it('replaces the product’s modifier-group link set, re-linking a removed group', async () => {
    const { token, businessId, productId } = await ctx();
    const g1 = await createGroup(token, businessId, milkGroup({ name: 'G1' }));
    const g2 = await createGroup(token, businessId, milkGroup({ name: 'G2' }));

    const link = (ids: string[]) =>
      request(server())
        .put(`/v1/portal/products/${productId}/modifier-groups`)
        .set('Authorization', `Bearer ${token}`)
        .send({ groupIds: ids })
        .expect(200);

    let res = await link([g1.id, g2.id]);
    expect(res.body.groupIds.sort()).toEqual([g1.id, g2.id].sort());

    res = await link([g2.id]); // drop g1
    expect(res.body.groupIds).toEqual([g2.id]);

    res = await link([g1.id, g2.id]); // re-add g1 (must restore, not violate unique)
    expect(res.body.groupIds.sort()).toEqual([g1.id, g2.id].sort());

    res = await link([]); // clear all
    expect(res.body.groupIds).toEqual([]);
  });

  it('rejects linking a modifier group from another business (422)', async () => {
    const a = await ctx();
    const b = await ctx();
    const foreign = await createGroup(b.token, b.businessId, milkGroup());

    await request(server())
      .put(`/v1/portal/products/${a.productId}/modifier-groups`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ groupIds: [foreign.id] })
      .expect(422);
  });

  it('rejects linking a non-existent modifier group (422)', async () => {
    const { token, productId } = await ctx();
    await request(server())
      .put(`/v1/portal/products/${productId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send({ groupIds: ['11111111-1111-4111-8111-111111111111'] })
      .expect(422);
  });

  it('rejects linking a group from the owner’s OTHER business (422)', async () => {
    const { token, productId } = await ctx(); // product lives in business 1
    // A second business (same owner) with its own modifier group.
    const biz2 = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Biz2', type: 'fnb', currency: 'PHP', taxRate: 0.12 })
      .expect(201);
    const foreignGroup = await createGroup(token, biz2.body.id, milkGroup());

    await request(server())
      .put(`/v1/portal/products/${productId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send({ groupIds: [foreignGroup.id] })
      .expect(422);
  });

  // =========================================================================
  // Discounts
  // =========================================================================

  it('creates a percent discount and audits it', async () => {
    const { token, businessId } = await ctx();
    const res = await request(server())
      .post(`/v1/portal/businesses/${businessId}/discounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Merienda 10%',
        kind: 'percent',
        value: 10,
        appliesTo: 'both',
      })
      .expect(201);
    expect(res.body.name).toBe('Merienda 10%');
    expect(res.body.value).toBe(10);

    const audit = await raw.auditLog.findMany({
      where: { action: 'discount.create', entityId: res.body.id },
    });
    expect(audit.length).toBe(1);
  });

  it('creates a fixed discount (centavos value)', async () => {
    const { token, businessId } = await ctx();
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/discounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '₱20 off', kind: 'fixed', value: 2000, appliesTo: 'order' })
      .expect(201);
  });

  it('rejects a percent discount out of 1–100 (422)', async () => {
    const { token, businessId } = await ctx();
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/discounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad', kind: 'percent', value: 101, appliesTo: 'both' })
      .expect(422);
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/discounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad', kind: 'percent', value: 0, appliesTo: 'both' })
      .expect(422);
  });

  it('lists, patches, and soft-deletes a discount', async () => {
    const { token, businessId } = await ctx();
    const created = await request(server())
      .post(`/v1/portal/businesses/${businessId}/discounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Barkada 5%',
        kind: 'percent',
        value: 5,
        appliesTo: 'order',
      })
      .expect(201);

    const list = await request(server())
      .get(`/v1/portal/businesses/${businessId}/discounts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((d: any) => d.id)).toContain(created.body.id);

    await request(server())
      .patch(`/v1/portal/discounts/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 7 })
      .expect(200);

    await request(server())
      .delete(`/v1/portal/discounts/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const after = await request(server())
      .get(`/v1/portal/businesses/${businessId}/discounts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body.map((d: any) => d.id)).not.toContain(created.body.id);
  });

  it('rejects a percent value above 100 on PATCH (422)', async () => {
    const { token, businessId } = await ctx();
    const created = await request(server())
      .post(`/v1/portal/businesses/${businessId}/discounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'P', kind: 'percent', value: 10, appliesTo: 'both' })
      .expect(201);
    await request(server())
      .patch(`/v1/portal/discounts/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 150 })
      .expect(422);
  });

  it('does not let an owner touch another owner’s discount', async () => {
    const a = await ctx();
    const b = await ctx();
    const disc = await request(server())
      .post(`/v1/portal/businesses/${a.businessId}/discounts`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'A', kind: 'percent', value: 10, appliesTo: 'both' })
      .expect(201);
    await request(server())
      .delete(`/v1/portal/discounts/${disc.body.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
  });
});
