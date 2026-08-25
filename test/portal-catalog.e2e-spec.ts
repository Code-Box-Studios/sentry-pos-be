/*
 * Task 12 — Portal catalog (categories, products, variants) e2e (TDD).
 *
 * Drives the real Nest app over HTTP with supertest under an owner-role token
 * (tenant scope via PortalAuthGuard). Exercises: category + product CRUD, nested
 * variant replace-set, cross-table (product + variant) SKU/barcode uniqueness,
 * partial-unique release on soft-delete, and archive-not-delete for products
 * with sales history.
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

/** Seed a sale + sale-item referencing a product so it has "sales history". */
async function seedSaleForProduct(businessId: string, productId: string) {
  const branch = await raw.branch.create({
    data: { businessId, name: 'Main', code: 'MN', address: 'x' },
  });
  const terminal = await raw.terminal.create({
    data: { branchId: branch.id, name: 'T1', code: 'T1' },
  });
  const sale = await raw.sale.create({
    data: {
      branchId: branch.id,
      terminalId: terminal.id,
      receiptNo: `R-${Date.now()}`,
      orderType: 'none',
      status: 'completed',
      subtotal: 100,
      tax: 12,
      total: 112,
      createdAtDevice: new Date(),
      draft: {},
    },
  });
  await raw.saleItem.create({
    data: {
      saleId: sale.id,
      productId,
      nameSnapshot: 'snap',
      qty: '1',
      unitPrice: 100,
      modifiers: {},
    },
  });
}

const productBody = (over: Record<string, unknown> = {}) => ({
  name: 'Iced Latte',
  sku: 'CF-102',
  barcode: 'BC-102',
  priceC: 12000,
  costC: 4000,
  soldBy: 'unit',
  trackStock: false,
  ...over,
});

describe('Portal catalog (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  async function ownerToken() {
    const { owner, user } = await seedOwner();
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    return { owner, user, token: accessToken };
  }

  /** Owner + token + a business + a category to hang products off. */
  async function ctx() {
    const { owner, token } = await ownerToken();
    const bizRes = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Biz', type: 'retail', currency: 'PHP', taxRate: 0.12 })
      .expect(201);
    const businessId = bizRes.body.id;
    const catRes = await request(server())
      .post(`/v1/portal/businesses/${businessId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Coffee', sortOrder: 1 })
      .expect(201);
    return { owner, token, businessId, categoryId: catRes.body.id };
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
  // Categories
  // =========================================================================

  it('CRUD a category (create/list/patch/soft-delete) with audit', async () => {
    const { token, businessId } = await ctx();

    const created = await request(server())
      .post(`/v1/portal/businesses/${businessId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bakery', sortOrder: 2 })
      .expect(201);
    expect(created.body.name).toBe('Bakery');
    expect(created.body.businessId).toBe(businessId);

    const audit = await raw.auditLog.findMany({
      where: { action: 'category.create', entityId: created.body.id },
    });
    expect(audit.length).toBe(1);

    const list = await request(server())
      .get(`/v1/portal/businesses/${businessId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(['Coffee', 'Bakery']),
    );

    await request(server())
      .patch(`/v1/portal/categories/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Baked Goods', sortOrder: 5 })
      .expect(200);

    await request(server())
      .delete(`/v1/portal/categories/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(server())
      .get(`/v1/portal/businesses/${businessId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .then((r) =>
        expect(r.body.map((c: any) => c.id)).not.toContain(created.body.id),
      );
  });

  // =========================================================================
  // Product create + variants + cost round-trip
  // =========================================================================

  it('creates a product with variants (priceC/costC), auto-audits, and round-trips cost', async () => {
    const { token, businessId, categoryId } = await ctx();

    const res = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        productBody({
          categoryId,
          variants: [
            { name: 'Small', priceC: 12000, costC: 4000 },
            { name: 'Large', sku: 'CF-102-L', priceC: 14500 },
          ],
        }),
      )
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.priceC).toBe(12000);
    expect(res.body.costC).toBe(4000); // cost round-trips for the portal
    expect(res.body.categoryId).toBe(categoryId);
    expect(res.body.variants).toHaveLength(2);
    const large = res.body.variants.find((v: any) => v.name === 'Large');
    expect(large.priceC).toBe(14500);
    expect(large.costC).toBeNull();

    // Stored in centavos on the schema's price/cost columns.
    const stored = await raw.product.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(stored.price).toBe(12000);
    expect(stored.cost).toBe(4000);

    const audit = await raw.auditLog.findMany({
      where: { action: 'product.create', entityId: res.body.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].actorType).toBe('owner');
  });

  it('gets and lists products with their live variants', async () => {
    const { token, businessId, categoryId } = await ctx();
    const created = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        productBody({
          categoryId,
          variants: [{ name: 'Small', priceC: 12000 }],
        }),
      )
      .expect(201);

    const one = await request(server())
      .get(`/v1/portal/products/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(one.body.id).toBe(created.body.id);
    expect(one.body.variants).toHaveLength(1);

    const list = await request(server())
      .get(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((p: any) => p.id)).toContain(created.body.id);
  });

  // =========================================================================
  // Variant replace-set (create / update / soft-delete to match the list)
  // =========================================================================

  it('replace-set variants on PATCH: add, update, and soft-delete to match', async () => {
    const { token, businessId, categoryId } = await ctx();
    const created = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        productBody({
          categoryId,
          variants: [
            { name: 'Small', priceC: 12000 },
            { name: 'Medium', priceC: 13000 },
          ],
        }),
      )
      .expect(201);
    const small = created.body.variants.find((v: any) => v.name === 'Small');
    const medium = created.body.variants.find((v: any) => v.name === 'Medium');

    // Keep Small (renamed), drop Medium, add Large.
    const patched = await request(server())
      .patch(`/v1/portal/products/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        variants: [
          { id: small.id, name: 'Small (8oz)', priceC: 12500 },
          { name: 'Large', priceC: 15000 },
        ],
      })
      .expect(200);

    const names = patched.body.variants.map((v: any) => v.name).sort();
    expect(names).toEqual(['Large', 'Small (8oz)']);
    expect(patched.body.variants).toHaveLength(2);

    // Medium was soft-deleted (deletedAt set), not hard-deleted.
    const removed = await raw.productVariant.findUniqueOrThrow({
      where: { id: medium.id },
    });
    expect(removed.deletedAt).not.toBeNull();

    // Kept variant retained its id.
    expect(patched.body.variants.map((v: any) => v.id)).toContain(small.id);
  });

  // =========================================================================
  // Cross-table SKU/barcode uniqueness (products + variants, business-wide)
  // =========================================================================

  it('rejects a duplicate product SKU (422)', async () => {
    const { token, businessId, categoryId } = await ctx();
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(productBody({ categoryId }))
      .expect(201);

    await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(productBody({ categoryId, name: 'Dup', barcode: 'BC-999' }))
      .expect(422);
  });

  it('rejects a variant barcode colliding with another product’s barcode (422)', async () => {
    const { token, businessId, categoryId } = await ctx();
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(productBody({ categoryId })) // barcode BC-102
      .expect(201);

    await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        productBody({
          categoryId,
          name: 'Other',
          sku: 'OT-1',
          barcode: 'OT-BC',
          variants: [{ name: 'V', priceC: 1000, barcode: 'BC-102' }],
        }),
      )
      .expect(422);
  });

  it('rejects a variant barcode colliding with another product’s variant barcode (422)', async () => {
    const { token, businessId, categoryId } = await ctx();
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        productBody({
          categoryId,
          variants: [{ name: 'V1', priceC: 1000, barcode: 'V-BC-1' }],
        }),
      )
      .expect(201);

    await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        productBody({
          categoryId,
          name: 'Other',
          sku: 'OT-1',
          barcode: 'OT-BC',
          variants: [{ name: 'V2', priceC: 1000, barcode: 'V-BC-1' }],
        }),
      )
      .expect(422);
  });

  it('rejects internal duplicate SKUs within one submission (422)', async () => {
    const { token, businessId, categoryId } = await ctx();
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        productBody({
          categoryId,
          sku: 'SAME',
          variants: [{ name: 'V', priceC: 1000, sku: 'SAME' }],
        }),
      )
      .expect(422);
  });

  // =========================================================================
  // Soft-delete releases the partial unique; archive-not-delete on sales
  // =========================================================================

  it('soft-deletes a no-history product and frees its SKU for reuse', async () => {
    const { token, businessId, categoryId } = await ctx();
    const first = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(productBody({ categoryId, sku: 'REUSE', barcode: 'REUSE-BC' }))
      .expect(201);

    await request(server())
      .delete(`/v1/portal/products/${first.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const gone = await raw.product.findUniqueOrThrow({
      where: { id: first.body.id },
    });
    expect(gone.deletedAt).not.toBeNull();

    // Same SKU is now free (partial unique excludes soft-deleted rows).
    await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(productBody({ categoryId, sku: 'REUSE', barcode: 'REUSE-BC' }))
      .expect(201);
  });

  it('archives (not deletes) a product with sales history', async () => {
    const { token, businessId, categoryId } = await ctx();
    const created = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(productBody({ categoryId }))
      .expect(201);

    await seedSaleForProduct(businessId, created.body.id);

    const del = await request(server())
      .delete(`/v1/portal/products/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(del.body.active).toBe(false);

    // Archived: active=false but NOT soft-deleted (deletedAt stays null).
    const row = await raw.product.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row.active).toBe(false);
    expect(row.deletedAt).toBeNull();
  });

  // =========================================================================
  // Validation + tenant isolation
  // =========================================================================

  it('rejects a categoryId from another business (422)', async () => {
    const a = await ctx();
    const b = await ctx(); // different owner + business + category

    await request(server())
      .post(`/v1/portal/businesses/${a.businessId}/products`)
      .set('Authorization', `Bearer ${a.token}`)
      .send(productBody({ categoryId: b.categoryId }))
      .expect(422);
  });

  it('does not let an owner touch another owner’s products', async () => {
    const a = await ctx();
    const b = await ctx();
    const aProd = await request(server())
      .post(`/v1/portal/businesses/${a.businessId}/products`)
      .set('Authorization', `Bearer ${a.token}`)
      .send(productBody({ categoryId: a.categoryId }))
      .expect(201);

    await request(server())
      .get(`/v1/portal/products/${aProd.body.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
    await request(server())
      .patch(`/v1/portal/products/${aProd.body.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'hijack' })
      .expect(404);
    await request(server())
      .delete(`/v1/portal/products/${aProd.body.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
    // B cannot create products under A's business.
    await request(server())
      .post(`/v1/portal/businesses/${a.businessId}/products`)
      .set('Authorization', `Bearer ${b.token}`)
      .send(productBody({ categoryId: a.categoryId, sku: 'X', barcode: 'Y' }))
      .expect(404);
  });

  it('rejects duplicate variant ids within one PATCH (422)', async () => {
    const { token, businessId, categoryId } = await ctx();
    const created = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        productBody({
          categoryId,
          variants: [{ name: 'Small', priceC: 12000 }],
        }),
      )
      .expect(201);
    const vid = created.body.variants[0].id;

    await request(server())
      .patch(`/v1/portal/products/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        variants: [
          { id: vid, name: 'A', priceC: 100 },
          { id: vid, name: 'B', priceC: 200 },
        ],
      })
      .expect(422);
  });

  it('soft-deletes (not archives) a product whose only sales are soft-deleted', async () => {
    const { token, businessId, categoryId } = await ctx();
    const created = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send(productBody({ categoryId }))
      .expect(201);

    await seedSaleForProduct(businessId, created.body.id);
    // The only sale-item is soft-deleted → no LIVE sales history remains.
    await raw.saleItem.updateMany({
      where: { productId: created.body.id },
      data: { deletedAt: new Date() },
    });

    await request(server())
      .delete(`/v1/portal/products/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = await raw.product.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row.deletedAt).not.toBeNull(); // fully soft-deleted
    expect(row.active).toBe(true); // NOT archived
  });
});
