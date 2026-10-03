/*
 * Task 21 — POS stock endpoints e2e.
 *
 * GET /pos/stock → StockLevel[] and POST /pos/stock/adjustments → the updated
 * StockLevel, both delegating to the shared StockService. Asserts Decimal columns
 * serialize as NUMBERS (qty 23.45), not strings.
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
import { hashSecret } from '../src/auth/hashing';
import { AuthService } from '../src/auth/auth.service';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
let seq = 0;

describe('POS stock endpoints (e2e)', () => {
  let app: INestApplication;

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
  const bearer = (t: string) => `Bearer ${t}`;

  async function seedWorld() {
    seq += 1;
    const owner = await raw.owner.create({
      data: {
        name: `Owner ${seq}`,
        email: `owner-${seq}-${Date.now()}@test.com`,
        status: 'active',
        maxBusinesses: 5,
      },
    });
    const ownerUser = await raw.user.create({
      data: {
        role: 'owner',
        ownerId: owner.id,
        email: owner.email,
        pinHash: await hashSecret('123456'),
      },
    });
    const business = await raw.business.create({
      data: {
        ownerId: owner.id,
        name: 'Kape',
        type: 'fnb',
        currency: 'PHP',
        taxRate: '0.12',
      },
    });
    const branch = await raw.branch.create({
      data: {
        businessId: business.id,
        name: 'Main',
        code: 'MN',
        address: '123 St',
      },
    });
    const deviceToken = randomBytes(32).toString('hex');
    await raw.terminal.create({
      data: {
        branchId: branch.id,
        name: 'Register 1',
        code: 'T1',
        deviceTokenHash: sha256(deviceToken),
      },
    });
    const category = await raw.category.create({
      data: { businessId: business.id, name: 'Dry', sortOrder: 1 },
    });
    // Weight product with a fractional stock level (Decimal 23.450).
    const rice = await raw.product.create({
      data: {
        businessId: business.id,
        categoryId: category.id,
        name: 'Rice',
        price: 6000,
        soldBy: 'weight',
        trackStock: true,
      },
    });
    await raw.branchStock.create({
      data: { branchId: branch.id, productId: rice.id, qty: '23.45' },
    });
    const unlocked = await request(server())
      .post('/v1/pos/operators/unlock')
      .set('Authorization', bearer(deviceToken))
      .send({ userId: ownerUser.id, pin: '123456' })
      .expect(201);
    return {
      owner,
      ownerUser,
      business,
      branch,
      deviceToken,
      operatorToken: unlocked.body.token as string,
      branchId: branch.id,
      rice,
    };
  }

  it('rejects unauthenticated access (401)', async () => {
    await request(server()).get('/v1/pos/stock').expect(401);
    await request(server())
      .post('/v1/pos/stock/adjustments')
      .send({})
      .expect(401);
  });

  it('returns stock levels with qty as a NUMBER (not a string)', async () => {
    const w = await seedWorld();
    const res = await request(server())
      .get('/v1/pos/stock')
      .set('Authorization', bearer(w.deviceToken))
      .expect(200);
    const level = res.body.find((s: any) => s.productId === w.rice.id);
    expect(level).toEqual({
      productId: w.rice.id,
      variantId: null,
      qty: 23.45,
    });
    expect(typeof level.qty).toBe('number');
  });

  it('adjusts a level to an absolute target and returns the updated StockLevel', async () => {
    const w = await seedWorld();
    const res = await request(server())
      .post('/v1/pos/stock/adjustments')
      .set('Authorization', bearer(w.deviceToken))
      .set('X-Operator-Token', w.operatorToken)
      .send({
        productId: w.rice.id,
        newQty: 10.5,
        reasonCategory: 'count_correction',
        note: 'recount',
      })
      .expect(201);
    expect(res.body).toEqual({
      productId: w.rice.id,
      variantId: null,
      qty: 10.5,
    });

    // Persisted + an adjustment movement was written.
    const level = await raw.branchStock.findFirstOrThrow({
      where: { branchId: w.branchId, productId: w.rice.id, variantId: null },
    });
    expect(level.qty.toString()).toBe('10.5');
    const moves = await raw.stockMovement.findMany({
      where: { productId: w.rice.id, type: 'adjustment' },
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].operatorUserId).toBe(w.ownerUser.id);
  });

  it('does not deadlock simultaneous manager portal and terminal stock writes', async () => {
    const w = await seedWorld();
    const manager = await raw.user.create({
      data: {
        role: 'manager',
        ownerId: w.owner.id,
        email: 'stock-manager@example.test',
        pinHash: await hashSecret('654321'),
        passwordHash: await hashSecret('manager-password'),
      },
    });
    await raw.staffProfile.create({
      data: {
        userId: manager.id,
        businessId: w.business.id,
        name: 'Mae',
        status: 'active',
        branches: { create: [{ branchId: w.branchId }] },
      },
    });
    const portal = await app
      .get(AuthService)
      .mintTokenPair(manager.id, 'manager', w.owner.id);
    const unlocked = await request(server())
      .post('/v1/pos/operators/unlock')
      .set('Authorization', bearer(w.deviceToken))
      .send({ userId: manager.id, pin: '654321' })
      .expect(201);
    let release!: () => void;
    let ready!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holding = raw.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${manager.id}::uuid FOR UPDATE`;
        ready();
        await blocked;
      },
      { timeout: 20000 },
    );
    const waitForWrites = async (minimum: number) => {
      for (let i = 0; i < 100; i++) {
        const rows = await raw.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'SELECT id FROM users%' OR query LIKE '%pg_advisory_xact_lock%')`;
        if (rows[0].count >= BigInt(minimum)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Stock writes did not reach their transaction locks.');
    };
    await locked;
    const terminalWrite = request(server())
      .post('/v1/pos/stock/adjustments')
      .set('Authorization', bearer(w.deviceToken))
      .set('X-Operator-Token', unlocked.body.token as string)
      .send({
        productId: w.rice.id,
        newQty: 10,
        reasonCategory: 'count_correction',
      })
      .then((response) => response);
    let portalWrite: Promise<request.Response> | undefined;
    try {
      await waitForWrites(1);
      portalWrite = request(server())
        .post(`/v1/portal/branches/${w.branchId}/stock/receive`)
        .set('Authorization', bearer(portal.accessToken))
        .send({ lines: [{ productId: w.rice.id, qty: 1 }] })
        .then((response) => response);
      await waitForWrites(2);
    } finally {
      release();
      await holding;
    }
    expect((await terminalWrite).status).toBe(201);
    expect((await portalWrite).status).toBe(201);
    expect(
      await raw.stockMovement.count({ where: { productId: w.rice.id } }),
    ).toBe(2);
  }, 15000);

  it('requires manager approval for a cashier stock adjustment and records both identities', async () => {
    const w = await seedWorld();
    const cashier = await raw.user.create({
      data: {
        role: 'cashier',
        ownerId: w.owner.id,
        pinHash: await hashSecret('654321'),
      },
    });
    await raw.staffProfile.create({
      data: {
        userId: cashier.id,
        businessId: w.business.id,
        name: 'Ana',
        status: 'active',
        branches: { create: [{ branchId: w.branchId }] },
      },
    });
    const manager = await raw.user.create({
      data: {
        role: 'manager',
        ownerId: w.owner.id,
        email: 'stock-manager@example.test',
        pinHash: await hashSecret('112233'),
      },
    });
    await raw.staffProfile.create({
      data: {
        userId: manager.id,
        businessId: w.business.id,
        name: 'Mia',
        status: 'active',
        branches: { create: [{ branchId: w.branchId }] },
      },
    });
    const unlocked = await request(server())
      .post('/v1/pos/operators/unlock')
      .set('Authorization', bearer(w.deviceToken))
      .send({ userId: cashier.id, pin: '654321' })
      .expect(201);
    const adjust = (approval?: { approverUserId: string; pin: string }) =>
      request(server())
        .post('/v1/pos/stock/adjustments')
        .set('Authorization', bearer(w.deviceToken))
        .set('X-Operator-Token', unlocked.body.token as string)
        .send({
          productId: w.rice.id,
          newQty: 10.5,
          reasonCategory: 'count_correction',
          approval,
        });
    await adjust().expect(403);
    expect(
      await raw.stockMovement.count({ where: { productId: w.rice.id } }),
    ).toBe(0);
    await adjust({ approverUserId: manager.id, pin: '112233' }).expect(201);
    const movement = await raw.stockMovement.findFirstOrThrow({
      where: { productId: w.rice.id, type: 'adjustment' },
    });
    expect(movement.operatorUserId).toBe(cashier.id);
    expect(movement.approvedByUserId).toBe(manager.id);
    const audit = await raw.auditLog.findFirstOrThrow({
      where: { entityId: movement.id, action: 'stockMovement.create' },
    });
    expect(audit.actorType).toBe('staff');
    expect(audit.actorId).toBe(cashier.id);
    expect(audit.metadata).toMatchObject({
      operatorUserId: cashier.id,
      operatorRole: 'cashier',
      approvedByUserId: manager.id,
      approverRole: 'manager',
    });
    expect(JSON.stringify(audit)).not.toContain('$argon2');
  });

  it.each(['approver PIN', 'device pairing'])(
    'rejects an adjustment if %s changes while its transaction waits',
    async (changed) => {
      const w = await seedWorld();
      const cashier = await raw.user.create({
        data: {
          role: 'cashier',
          ownerId: w.owner.id,
          pinHash: await hashSecret('654321'),
        },
      });
      await raw.staffProfile.create({
        data: {
          userId: cashier.id,
          businessId: w.business.id,
          name: 'Ana',
          status: 'active',
          branches: { create: [{ branchId: w.branchId }] },
        },
      });
      const unlocked = await request(server())
        .post('/v1/pos/operators/unlock')
        .set('Authorization', bearer(w.deviceToken))
        .send({ userId: cashier.id, pin: '654321' })
        .expect(201);
      const terminal = await raw.terminal.findFirstOrThrow({
        where: { branchId: w.branchId },
      });
      await raw.terminal.update({
        where: { id: terminal.id },
        data: { lastSeenAt: new Date() },
      });
      const replacementHash = await hashSecret('998877');
      let release!: () => void;
      let ready!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const transaction = raw.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM terminals WHERE id = ${terminal.id}::uuid FOR UPDATE`;
          ready();
          await hold;
          if (changed === 'approver PIN') {
            await tx.user.update({
              where: { id: w.ownerUser.id },
              data: { pinHash: replacementHash },
            });
          } else {
            await tx.terminal.update({
              where: { id: terminal.id },
              data: { deviceTokenHash: sha256('replacement-device') },
            });
          }
        },
        { timeout: 20000 },
      );
      await locked;
      const pending = request(server())
        .post('/v1/pos/stock/adjustments')
        .set('Authorization', bearer(w.deviceToken))
        .set('X-Operator-Token', unlocked.body.token as string)
        .send({
          productId: w.rice.id,
          newQty: 10,
          reasonCategory: 'count_correction',
          approval: { approverUserId: w.ownerUser.id, pin: '123456' },
        })
        .then((response) => response);
      let waiting = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const rows = await raw.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE 'SELECT id FROM terminals%'
      `;
        if (rows[0]?.count > 0n) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await transaction;
      const response = await pending;
      expect(waiting).toBe(true);
      expect(response.status).toBe(changed === 'approver PIN' ? 403 : 401);
      expect(
        await raw.stockMovement.count({ where: { productId: w.rice.id } }),
      ).toBe(0);
    },
    15000,
  );

  it('rejects a negative adjustment target (422)', async () => {
    const w = await seedWorld();
    await request(server())
      .post('/v1/pos/stock/adjustments')
      .set('Authorization', bearer(w.deviceToken))
      .set('X-Operator-Token', w.operatorToken)
      .send({
        productId: w.rice.id,
        newQty: -1,
        reasonCategory: 'damage',
      })
      .expect(422);
  });
});
