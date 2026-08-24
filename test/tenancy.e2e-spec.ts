/*
 * These e2e tests seed via the raw client and assert on dynamically-shaped
 * results (nested relations, JSON `changes` payloads), which are inherently
 * `any`-typed. The unsafe-* rules add noise without value here, so they are
 * disabled file-wide for this test.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { resetDb, closeDb } from './helpers/db';
import { PrismaService } from '../src/prisma/prisma.service';
import { createScopedPrisma } from '../src/prisma/scoped-prisma';
import {
  requestContext,
  RequestContext,
  runWithTxClient,
} from '../src/common/context/request-context';

/**
 * Task 4 — the tenancy + audit choke-point extension (e2e, TDD).
 *
 * Each test seeds via the RAW client (bypassing all scoping), then runs the
 * scoped client inside a hand-built `requestContext.run(...)` and asserts the
 * extension's behavior: tenant/platform scoping, soft-deletes, child-only
 * blocks, create policing, and atomic audit write-through.
 */

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

function baseCtx(patch: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'req-' + Math.random().toString(16).slice(2),
    scope: null,
    actor: null,
    ownerId: null,
    businessId: null,
    branchId: null,
    terminalCode: null,
    sessionId: null,
    ip: '127.0.0.1',
    userAgent: 'jest',
    deviceTimestamp: null,
    ...patch,
  };
}

function ownerCtx(ownerId: string, patch: Partial<RequestContext> = {}) {
  return baseCtx({
    scope: 'tenant',
    actor: { type: 'owner', id: ownerId },
    ownerId,
    ...patch,
  });
}

function terminalCtx(
  ownerId: string,
  businessId: string,
  branchId: string,
  terminalId?: string,
  patch: Partial<RequestContext> = {},
) {
  return baseCtx({
    scope: 'tenant',
    // actorId is a UUID column — use the real terminal id (or a valid uuid).
    actor: { type: 'terminal', id: terminalId ?? randomUUID() },
    ownerId,
    businessId,
    branchId,
    terminalCode: 'T-01',
    ...patch,
  });
}

function platformCtx(adminId = 'admin-1') {
  return baseCtx({
    scope: 'platform',
    actor: { type: 'platform_admin', id: adminId },
    ownerId: null,
  });
}

/**
 * Run `fn` inside a fresh request-context store and AWAIT it there.
 *
 * Prisma ops are lazy PrismaPromises: the extension's `$allOperations` hook —
 * and thus `getContext()` — fires when the promise is AWAITED, not when it is
 * created. If we let `requestContext.run(ctx, () => scoped.x())` return the
 * promise, the await happens after `run` exits and the ALS store is gone. In
 * production the ContextMiddleware wraps the whole request so everything is
 * awaited inside `run`; this helper mirrors that so tests exercise the real path.
 */
function runAs<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return requestContext.run(ctx, async () => await fn());
}

describe('Tenancy + audit choke-point extension (e2e)', () => {
  const raw = new PrismaClient() as unknown as PrismaService;
  const scoped = createScopedPrisma(raw);

  beforeAll(async () => {
    await (raw as unknown as PrismaClient).$connect();
  });

  afterAll(async () => {
    await (raw as unknown as PrismaClient).$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  // -------------------------------------------------------------------------
  // Seed helpers (raw client — no scoping)
  // -------------------------------------------------------------------------

  async function seedOwnerTree(label: string) {
    const owner = await raw.owner.create({
      data: {
        name: `Owner ${label}`,
        email: `owner-${label}-${Date.now()}@t.com`,
      },
    });
    const business = await raw.business.create({
      data: {
        ownerId: owner.id,
        name: `Biz ${label}`,
        type: 'retail',
        taxRate: 0.12,
      },
    });
    const branch = await raw.branch.create({
      data: {
        businessId: business.id,
        name: `Branch ${label}`,
        code: `B-${label}`,
        address: 'x',
      },
    });
    const terminal = await raw.terminal.create({
      data: { branchId: branch.id, name: `Term ${label}`, code: `T-${label}` },
    });
    const category = await raw.category.create({
      data: { businessId: business.id, name: `Cat ${label}` },
    });
    const product = await raw.product.create({
      data: {
        businessId: business.id,
        categoryId: category.id,
        name: `Prod ${label}`,
        price: 1000,
      },
    });
    return { owner, business, branch, terminal, category, product };
  }

  // =========================================================================
  // Rule 1: no context / no scope → throw
  // =========================================================================

  it('throws when called outside any request context', async () => {
    await expect(scoped.business.findMany()).rejects.toThrow(
      /outside an authenticated request context/i,
    );
  });

  it('throws when context has no scope', async () => {
    const ctx = baseCtx({ scope: null });
    await runAs(ctx, async () => {
      await expect(scoped.business.findMany()).rejects.toThrow(
        /outside an authenticated request context/i,
      );
    });
  });

  // =========================================================================
  // Rule 2: tenant reads — owner isolation
  // =========================================================================

  it('owner A business.findMany sees only A businesses (B exists)', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    const rows = await runAs(ownerCtx(a.owner.id), () =>
      scoped.business.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.business.id);
    expect(ids).not.toContain(b.business.id);
  });

  it('owner A id-targeted update of owner B product affects 0 rows', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    const res = await runAs(ownerCtx(a.owner.id), () =>
      scoped.product.updateMany({
        where: { id: b.product.id },
        data: { name: 'HACKED' },
      }),
    );
    expect(res.count).toBe(0);

    const stillThere = await raw.product.findUnique({
      where: { id: b.product.id },
    });
    expect(stillThere?.name).not.toBe('HACKED');
  });

  it('terminal sale.findMany is filtered to its branch only', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    const saleA = await raw.sale.create({
      data: {
        branchId: a.branch.id,
        terminalId: a.terminal.id,
        receiptNo: 'R-A-1',
        orderType: 'none',
        status: 'completed',
        subtotal: 100,
        tax: 12,
        total: 112,
        createdAtDevice: new Date(),
        draft: {},
      },
    });
    await raw.sale.create({
      data: {
        branchId: b.branch.id,
        terminalId: b.terminal.id,
        receiptNo: 'R-B-1',
        orderType: 'none',
        status: 'completed',
        subtotal: 100,
        tax: 12,
        total: 112,
        createdAtDevice: new Date(),
        draft: {},
      },
    });

    const rows = await runAs(
      terminalCtx(a.owner.id, a.business.id, a.branch.id, a.terminal.id),
      () => scoped.sale.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([saleA.id]);
  });

  // =========================================================================
  // Rule 4: platform scope reads all; tenant write throws PlatformWriteError
  // =========================================================================

  it('platform scope reads everything but product.update throws PlatformWriteError', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    const rows = await runAs(platformCtx(), () => scoped.product.findMany());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.product.id);
    expect(ids).toContain(b.product.id);

    await runAs(platformCtx(), async () => {
      await expect(
        scoped.product.update({
          where: { id: a.product.id },
          data: { name: 'x' },
        }),
      ).rejects.toThrow(/PlatformWriteError/);
    });
  });

  // =========================================================================
  // Rule 5: audit write-through
  // =========================================================================

  it('tenant product.update writes an audit row with before/after and requestId', async () => {
    const a = await seedOwnerTree('A');
    const ctx = ownerCtx(a.owner.id);

    await runAs(ctx, () =>
      scoped.product.update({
        where: { id: a.product.id },
        data: { name: 'Renamed', price: 2000 },
      }),
    );

    const logs = await raw.auditLog.findMany({
      where: { entityId: a.product.id, action: 'product.update' },
    });
    expect(logs).toHaveLength(1);
    const changes = logs[0].changes as { before: any; after: any };
    expect(changes.before.name).toBe('Prod A');
    expect(changes.after.name).toBe('Renamed');
    expect(changes.after.price).toBe(2000);
    const meta = logs[0].metadata as { requestId?: string };
    expect(meta.requestId).toBe(ctx.requestId);
    expect(logs[0].ownerId).toBe(a.owner.id);
  });

  it('audit is atomic: a forced mutation failure leaves ZERO audit rows', async () => {
    const a = await seedOwnerTree('A');

    // The mutation itself fails inside the extension's transaction (qty < 0
    // violates branch_stock_qty_nonnegative), so the whole tx aborts and no
    // audit row is committed.
    const bs = await raw.branchStock.create({
      data: { branchId: a.branch.id, productId: a.product.id, qty: 5 },
    });

    await runAs(ownerCtx(a.owner.id), async () => {
      await expect(
        scoped.branchStock.update({
          where: { id: bs.id },
          data: { qty: -1 }, // violates branch_stock_qty_nonnegative CHECK
        }),
      ).rejects.toThrow();
    });

    const auditCount = await raw.auditLog.count({
      where: { entityId: bs.id },
    });
    expect(auditCount).toBe(0);
    const still = await raw.branchStock.findUnique({ where: { id: bs.id } });
    expect(Number(still?.qty)).toBe(5);
  });

  it('registered-tx path: a successful mutation + audit both roll back when the outer tx aborts', async () => {
    // Proves rule 5's stronger guarantee: when a service opens its OWN
    // transaction and registers it, the extension writes BOTH the mutation and
    // its audit row on that tx. If the outer tx later aborts, the ALREADY-
    // written audit row is rolled back with the mutation — zero rows remain.
    const a = await seedOwnerTree('A');
    const ctx = ownerCtx(a.owner.id);

    await requestContext.run(ctx, async () => {
      await expect(
        raw.$transaction(async (tx) => {
          await runWithTxClient(tx, async () => {
            // Rides the registered tx: update succeeds, audit row inserted on tx.
            await scoped.product.update({
              where: { id: a.product.id },
              data: { name: 'InTx' },
            });
          });
          // Confirm the audit row IS visible within this same tx before abort.
          const midCount = await tx.auditLog.count({
            where: { entityId: a.product.id },
          });
          expect(midCount).toBe(1);
          throw new Error('FORCE ROLLBACK');
        }),
      ).rejects.toThrow('FORCE ROLLBACK');
    });

    // After rollback: neither the rename nor the audit row survived.
    const prod = await raw.product.findUnique({ where: { id: a.product.id } });
    expect(prod?.name).toBe('Prod A');
    const auditCount = await raw.auditLog.count({
      where: { entityId: a.product.id },
    });
    expect(auditCount).toBe(0);
  });

  // =========================================================================
  // Rule 6: soft deletes
  // =========================================================================

  it('product.delete soft-deletes, hides from later reads, audits prior state', async () => {
    const a = await seedOwnerTree('A');

    await runAs(ownerCtx(a.owner.id), () =>
      scoped.product.delete({ where: { id: a.product.id } }),
    );

    // Row still physically exists with deleted_at set
    const rawRow = await raw.product.findUnique({
      where: { id: a.product.id },
    });
    expect(rawRow).not.toBeNull();
    expect(rawRow?.deletedAt).not.toBeNull();

    // Scoped reads exclude it
    const visible = await runAs(ownerCtx(a.owner.id), () =>
      scoped.product.findMany(),
    );
    expect(visible.map((r) => r.id)).not.toContain(a.product.id);

    // includeDeleted:true reveals it again
    const withDeleted = await runAs(ownerCtx(a.owner.id), () =>
      scoped.product.findMany({ includeDeleted: true } as any),
    );
    expect(withDeleted.map((r) => r.id)).toContain(a.product.id);

    // Audit logs prior state
    const logs = await raw.auditLog.findMany({
      where: { entityId: a.product.id, action: 'product.delete' },
    });
    expect(logs).toHaveLength(1);
    const changes = logs[0].changes as { before: any };
    expect(changes.before.name).toBe('Prod A');
  });

  it('nested include of a soft-deleted child relation is filtered out', async () => {
    const a = await seedOwnerTree('A');
    const liveVariant = await raw.productVariant.create({
      data: { productId: a.product.id, name: 'Live', price: 100 },
    });
    const deadVariant = await raw.productVariant.create({
      data: {
        productId: a.product.id,
        name: 'Dead',
        price: 100,
        deletedAt: new Date(),
      },
    });

    const prod = await runAs(ownerCtx(a.owner.id), () =>
      scoped.product.findFirst({
        where: { id: a.product.id },
        include: { variants: true },
      }),
    );
    const variantIds = (prod as any).variants.map((v: any) => v.id);
    expect(variantIds).toContain(liveVariant.id);
    expect(variantIds).not.toContain(deadVariant.id);
  });

  // =========================================================================
  // auditLog immutability at app layer
  // =========================================================================

  it('auditLog.update throws at the app layer', async () => {
    const a = await seedOwnerTree('A');
    // create a real audit row via a scoped mutation
    await runAs(ownerCtx(a.owner.id), () =>
      scoped.product.update({
        where: { id: a.product.id },
        data: { name: 'z' },
      }),
    );
    const log = await raw.auditLog.findFirst({
      where: { entityId: a.product.id },
    });

    await runAs(ownerCtx(a.owner.id), async () => {
      await expect(
        scoped.auditLog.update({
          where: { id: log!.id },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Child-only models
  // =========================================================================

  it('modifier.findMany in tenant scope throws (child-only)', async () => {
    const a = await seedOwnerTree('A');
    await runAs(ownerCtx(a.owner.id), async () => {
      await expect(scoped.modifier.findMany()).rejects.toThrow(
        /child-only|modifierGroup/i,
      );
    });
  });

  // =========================================================================
  // Rule 3: creates policed
  // =========================================================================

  it('owner A product.create carrying owner B businessId throws', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    await runAs(ownerCtx(a.owner.id), async () => {
      await expect(
        scoped.product.create({
          data: {
            businessId: b.business.id, // B's business
            categoryId: b.category.id,
            name: 'Sneaky',
            price: 500,
          },
        }),
      ).rejects.toThrow();
    });

    const leaked = await raw.product.findMany({
      where: { name: 'Sneaky' },
    });
    expect(leaked).toHaveLength(0);
  });

  it('branchStock.upsert targeting owner B branch throws with no row written', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    await runAs(ownerCtx(a.owner.id), async () => {
      await expect(
        scoped.branchStock.upsert({
          where: { id: '00000000-0000-0000-0000-000000000000' },
          create: {
            branchId: b.branch.id,
            productId: b.product.id,
            qty: 3,
          },
          update: { qty: 3 },
        }),
      ).rejects.toThrow();
    });

    const rows = await raw.branchStock.findMany({
      where: { branchId: b.branch.id },
    });
    expect(rows).toHaveLength(0);
  });

  // =========================================================================
  // Rule 3: sibling FK + nested connect create-policing (cross-link defense)
  // =========================================================================

  it('owner A product.create with own businessId but owner B categoryId throws (sibling FK)', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    await runAs(ownerCtx(a.owner.id), async () => {
      await expect(
        scoped.product.create({
          data: {
            businessId: a.business.id, // A's own business (passes direct-scope)
            categoryId: b.category.id, // but B's category — must be rejected
            name: 'CrossLink',
            price: 500,
          },
        }),
      ).rejects.toThrow(/scope/i);
    });

    const leaked = await raw.product.findMany({ where: { name: 'CrossLink' } });
    expect(leaked).toHaveLength(0);
  });

  it('owner A product.create with nested connect to owner B category throws', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    await runAs(ownerCtx(a.owner.id), async () => {
      await expect(
        scoped.product.create({
          data: {
            name: 'NestedConnect',
            price: 500,
            business: { connect: { id: a.business.id } },
            category: { connect: { id: b.category.id } }, // B's category
          },
        }),
      ).rejects.toThrow(/scope/i);
    });

    const leaked = await raw.product.findMany({
      where: { name: 'NestedConnect' },
    });
    expect(leaked).toHaveLength(0);
  });

  it('owner A branchStock.create referencing owner B product throws', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    await runAs(ownerCtx(a.owner.id), async () => {
      await expect(
        scoped.branchStock.create({
          data: {
            branchId: a.branch.id, // A's own branch
            productId: b.product.id, // but B's product — reject
            qty: 5,
          },
        }),
      ).rejects.toThrow(/scope/i);
    });

    const leaked = await raw.branchStock.findMany({
      where: { productId: b.product.id },
    });
    expect(leaked).toHaveLength(0);
  });

  it('REGRESSION: create with a null optional FK is NOT rejected (misc-line style)', async () => {
    const a = await seedOwnerTree('A');

    // (a) top-level: branchStock.variantId is an optional FK backing a relation —
    // passing null must succeed (not be treated as an out-of-scope ref).
    const created = await runAs(ownerCtx(a.owner.id), () =>
      scoped.branchStock.create({
        data: {
          branchId: a.branch.id,
          productId: a.product.id,
          variantId: null, // legitimate absence — must not throw
          qty: 7,
        },
      }),
    );
    expect(created.id).toBeDefined();
    expect(created.variantId).toBeNull();

    // (b) nested: a misc-line saleItem with productId = null inside a sale create
    // must also succeed (the canonical §-example the policing must not break).
    const sale = await runAs(
      terminalCtx(a.owner.id, a.business.id, a.branch.id, a.terminal.id),
      () =>
        scoped.sale.create({
          data: {
            branchId: a.branch.id,
            terminalId: a.terminal.id,
            receiptNo: 'R-MISC-1',
            orderType: 'none',
            status: 'completed',
            subtotal: 100,
            tax: 12,
            total: 112,
            createdAtDevice: new Date(),
            draft: {},
            items: {
              create: [
                {
                  productId: null, // misc line — no product
                  nameSnapshot: 'Misc item',
                  qty: 1,
                  unitPrice: 100,
                  modifiers: {},
                },
              ],
            },
          },
        }),
    );
    expect(sale.id).toBeDefined();
    const items = await raw.saleItem.findMany({ where: { saleId: sale.id } });
    expect(items).toHaveLength(1);
    expect(items[0].productId).toBeNull();
  });

  // =========================================================================
  // Owner context on branch-scoped models
  // =========================================================================

  it('owner A branchStock.findMany returns only rows under A branches', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');
    const bsA = await raw.branchStock.create({
      data: { branchId: a.branch.id, productId: a.product.id, qty: 1 },
    });
    const bsB = await raw.branchStock.create({
      data: { branchId: b.branch.id, productId: b.product.id, qty: 1 },
    });

    const rows = await runAs(ownerCtx(a.owner.id), () =>
      scoped.branchStock.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(bsA.id);
    expect(ids).not.toContain(bsB.id);

    const upd = await runAs(ownerCtx(a.owner.id), () =>
      scoped.branchStock.updateMany({
        where: { id: bsB.id },
        data: { qty: 99 },
      }),
    );
    expect(upd.count).toBe(0);
  });

  // =========================================================================
  // Nested writes
  // =========================================================================

  it('nested variant price change in product.update audits variant before/after', async () => {
    const a = await seedOwnerTree('A');
    const variant = await raw.productVariant.create({
      data: { productId: a.product.id, name: 'V1', price: 100 },
    });

    await runAs(ownerCtx(a.owner.id), () =>
      scoped.product.update({
        where: { id: a.product.id },
        data: {
          variants: {
            update: {
              where: { id: variant.id },
              data: { price: 250 },
            },
          },
        },
      }),
    );

    const logs = await raw.auditLog.findMany({
      where: { entityId: variant.id, entityType: 'productVariant' },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const changes = logs[0].changes as { before: any; after: any };
    expect(changes.before.price).toBe(100);
    expect(changes.after.price).toBe(250);
  });

  it('nested variant delete lands as a soft delete', async () => {
    const a = await seedOwnerTree('A');
    const variant = await raw.productVariant.create({
      data: { productId: a.product.id, name: 'V1', price: 100 },
    });

    await runAs(ownerCtx(a.owner.id), () =>
      scoped.product.update({
        where: { id: a.product.id },
        data: {
          variants: {
            delete: { id: variant.id },
          },
        },
      }),
    );

    const row = await raw.productVariant.findUnique({
      where: { id: variant.id },
    });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
  });

  // =========================================================================
  // createMany → one audit row per record
  // =========================================================================

  it('tenant createMany logs one audit row per created record', async () => {
    const a = await seedOwnerTree('A');

    await runAs(ownerCtx(a.owner.id), () =>
      scoped.category.createMany({
        data: [
          { businessId: a.business.id, name: 'C1' },
          { businessId: a.business.id, name: 'C2' },
          { businessId: a.business.id, name: 'C3' },
        ],
      }),
    );

    const logs = await raw.auditLog.findMany({
      where: { action: 'category.createMany' },
    });
    expect(logs).toHaveLength(3);
    for (const l of logs) {
      expect(l.businessId).toBe(a.business.id);
      expect(l.ownerId).toBe(a.owner.id);
    }
  });

  // =========================================================================
  // Entity-derived scope stamping
  // =========================================================================

  it('owner-context product update (no businessId in ctx) stamps audit businessId from the entity', async () => {
    const a = await seedOwnerTree('A');
    const ctx = ownerCtx(a.owner.id);
    expect(ctx.businessId).toBeNull();

    await runAs(ctx, () =>
      scoped.product.update({
        where: { id: a.product.id },
        data: { name: 'Q' },
      }),
    );

    const log = await raw.auditLog.findFirst({
      where: { entityId: a.product.id, action: 'product.update' },
    });
    expect(log?.businessId).toBe(a.business.id);
    expect(log?.businessId).not.toBeNull();
  });

  // =========================================================================
  // BO audit visibility
  // =========================================================================

  it('tenant auditLog.findMany excludes platform_admin rows and includes null-business owner rows', async () => {
    const a = await seedOwnerTree('A');

    // A platform_admin row against A's business — must be hidden from the BO
    await raw.auditLog.create({
      data: {
        actorType: 'platform_admin',
        ownerId: a.owner.id,
        businessId: a.business.id,
        action: 'platform.read',
        entityType: 'business',
        entityId: a.business.id,
        changes: {},
        metadata: {},
      },
    });

    // A null-business auth row owned by A — must be visible
    const authRow = await raw.auditLog.create({
      data: {
        actorType: 'owner',
        ownerId: a.owner.id,
        businessId: null,
        action: 'auth.login',
        entityType: 'user',
        changes: {},
        metadata: {},
      },
    });

    // A business row of A — visible
    const bizRow = await raw.auditLog.create({
      data: {
        actorType: 'owner',
        ownerId: a.owner.id,
        businessId: a.business.id,
        action: 'product.update',
        entityType: 'product',
        changes: {},
        metadata: {},
      },
    });

    const rows = await runAs(ownerCtx(a.owner.id), () =>
      scoped.auditLog.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(authRow.id);
    expect(ids).toContain(bizRow.id);
    expect(rows.every((r) => r.actorType !== 'platform_admin')).toBe(true);
  });

  // =========================================================================
  // Notification (spec §6) — businessId scoping via the scoped client
  // =========================================================================

  it('notification create + read scope by businessId (A cannot see B notifications)', async () => {
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    // Owner A creates a notification (scoped businessId forced/validated to A).
    const created = await runAs(ownerCtx(a.owner.id), () =>
      scoped.notification.create({
        data: {
          businessId: a.business.id,
          recipientType: 'user',
          recipientId: a.owner.id,
          type: 'low_stock',
          title: 'Low stock',
          body: 'Product running low',
        },
      }),
    );
    expect(created.id).toBeDefined();
    expect(created.businessId).toBe(a.business.id);

    // Seed a notification under owner B directly.
    const bNotif = await raw.notification.create({
      data: {
        businessId: b.business.id,
        recipientType: 'user',
        recipientId: b.owner.id,
        type: 'low_stock',
        title: 'B low stock',
        body: 'B product low',
      },
    });

    // Owner A's scoped read sees only A's notification.
    const rows = await runAs(ownerCtx(a.owner.id), () =>
      scoped.notification.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(created.id);
    expect(ids).not.toContain(bNotif.id);
  });
});
