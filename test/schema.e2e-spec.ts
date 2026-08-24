import { PrismaClient } from '@prisma/client';
import { resetDb } from './helpers/db';

/**
 * Schema integrity e2e tests (Task 2).
 *
 * These tests connect DIRECTLY to the test database via PrismaClient — no Nest
 * app bootstrap needed — to verify the database constraints and triggers put in
 * place by the `constraints` migration.
 *
 * Tests:
 * 1. audit_logs immutability trigger: INSERT works; UPDATE and DELETE both
 *    raise the trigger exception with the message "audit_logs is append-only".
 * 2. branch_stock qty CHECK: inserting qty = -1 raises a CHECK violation.
 * 3. products SKU partial unique: deleting a product releases its SKU so a
 *    new product can reuse it.
 */

describe('Schema integrity constraints', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
  });

  // -------------------------------------------------------------------------
  // Helpers — minimal seed data
  // -------------------------------------------------------------------------

  async function createOwner() {
    return prisma.owner.create({
      data: { name: 'Test Owner', email: `owner-${Date.now()}@test.com` },
    });
  }

  async function createBusiness(ownerId: string) {
    return prisma.business.create({
      data: {
        ownerId,
        name: 'Test Business',
        type: 'retail',
        taxRate: 0.12,
      },
    });
  }

  async function createBranch(businessId: string) {
    return prisma.branch.create({
      data: {
        businessId,
        name: 'Main Branch',
        code: 'MAIN',
        address: '123 Test St',
      },
    });
  }

  async function createCategory(businessId: string) {
    return prisma.category.create({
      data: { businessId, name: 'Test Category' },
    });
  }

  async function createProduct(
    businessId: string,
    categoryId: string,
    sku?: string,
  ) {
    return prisma.product.create({
      data: {
        businessId,
        categoryId,
        name: 'Test Product',
        price: 1000,
        ...(sku ? { sku } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // 1. audit_logs immutability
  // -------------------------------------------------------------------------

  describe('audit_logs immutability trigger', () => {
    it('allows INSERT into audit_logs', async () => {
      const log = await prisma.auditLog.create({
        data: {
          actorType: 'platform_admin',
          action: 'test.action',
          entityType: 'test',
          changes: {},
          metadata: { ip: '127.0.0.1' },
        },
      });
      expect(log.id).toBeDefined();
    });

    it('rejects UPDATE on audit_logs with trigger message', async () => {
      const log = await prisma.auditLog.create({
        data: {
          actorType: 'platform_admin',
          action: 'test.action',
          entityType: 'test',
          changes: {},
          metadata: {},
        },
      });

      // Use $executeRaw so we get the trigger error even for row-matched updates
      await expect(
        prisma.$executeRaw`UPDATE audit_logs SET action = 'mutated' WHERE id = ${log.id}::uuid`,
      ).rejects.toThrow('audit_logs is append-only');
    });

    it('rejects DELETE on audit_logs with trigger message', async () => {
      const log = await prisma.auditLog.create({
        data: {
          actorType: 'platform_admin',
          action: 'test.action',
          entityType: 'test',
          changes: {},
          metadata: {},
        },
      });

      await expect(
        prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${log.id}::uuid`,
      ).rejects.toThrow('audit_logs is append-only');
    });
  });

  // -------------------------------------------------------------------------
  // 2. branch_stock qty CHECK constraint
  // -------------------------------------------------------------------------

  describe('branch_stock qty non-negative CHECK', () => {
    it('rejects inserting qty = -1 into branch_stock', async () => {
      const owner = await createOwner();
      const business = await createBusiness(owner.id);
      const branch = await createBranch(business.id);
      const category = await createCategory(business.id);
      const product = await createProduct(business.id, category.id);

      await expect(
        prisma.$executeRaw`
          INSERT INTO branch_stock (id, created_at, updated_at, branch_id, product_id, qty)
          VALUES (gen_random_uuid(), NOW(), NOW(), ${branch.id}::uuid, ${product.id}::uuid, -1)
        `,
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Products SKU partial unique index
  // -------------------------------------------------------------------------

  describe('products SKU partial unique index (WHERE deleted_at IS NULL)', () => {
    it('allows re-using a SKU after the original product is soft-deleted', async () => {
      const owner = await createOwner();
      const business = await createBusiness(owner.id);
      const category = await createCategory(business.id);
      const sku = `SKU-${Date.now()}`;

      // Create product with SKU
      const original = await createProduct(business.id, category.id, sku);
      expect(original.sku).toBe(sku);

      // Soft-delete it (sets deleted_at — releases the partial unique)
      await prisma.product.update({
        where: { id: original.id },
        data: { deletedAt: new Date() },
      });

      // Create a new product with the same SKU — should succeed
      const reused = await createProduct(business.id, category.id, sku);
      expect(reused.sku).toBe(sku);
      expect(reused.id).not.toBe(original.id);
    });

    it('rejects duplicate SKU among live products', async () => {
      const owner = await createOwner();
      const business = await createBusiness(owner.id);
      const category = await createCategory(business.id);
      const sku = `SKU-DUPE-${Date.now()}`;

      await createProduct(business.id, category.id, sku);

      // Attempt to create another live product with the same SKU via raw SQL
      // (Prisma ORM won't hit the partial index otherwise since it's not a @@unique)
      await expect(
        prisma.$executeRaw`
          INSERT INTO products (id, created_at, updated_at, business_id, category_id, name, price, sku, sold_by, track_stock, track_expiry, active)
          VALUES (gen_random_uuid(), NOW(), NOW(), ${business.id}::uuid, ${category.id}::uuid, 'Duplicate', 999, ${sku}, 'unit', true, false, true)
        `,
      ).rejects.toThrow();
    });
  });
});
