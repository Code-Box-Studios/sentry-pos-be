/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { createHash } from 'crypto';
import { Server } from 'node:http';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashSecret } from '../src/auth/hashing';
import { closeDb, resetDb } from './helpers/db';

const raw = new PrismaClient();
const deviceToken = 'staff-operator-device-token';
const deviceHash = createHash('sha256').update(deviceToken).digest('hex');

describe('terminal human operator sessions (e2e)', () => {
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

  beforeEach(async () => resetDb());

  const server = (): Server => app.getHttpServer() as Server;
  const device = (call: request.Test) =>
    call.set('Authorization', `Bearer ${deviceToken}`);

  async function fixture(ownerPin: string | null = '123456') {
    const owner = await raw.owner.create({
      data: {
        name: 'Owner',
        email: 'owner-operator@example.test',
        status: 'active',
      },
    });
    const ownerUser = await raw.user.create({
      data: {
        role: 'owner',
        ownerId: owner.id,
        email: owner.email,
        pinHash: ownerPin ? await hashSecret(ownerPin) : null,
      },
    });
    const business = await raw.business.create({
      data: { ownerId: owner.id, name: 'Shop', type: 'retail', taxRate: 0.12 },
    });
    const branch = await raw.branch.create({
      data: {
        businessId: business.id,
        name: 'Main',
        code: 'MAIN',
        address: 'Street',
      },
    });
    const terminal = await raw.terminal.create({
      data: {
        branchId: branch.id,
        name: 'Till',
        code: 'T-1',
        deviceTokenHash: deviceHash,
      },
    });
    return { owner, ownerUser, business, branch, terminal };
  }

  it('shows an assigned roster and lets an owner unlock and lock without persisting the raw token', async () => {
    const { ownerUser, business, branch, terminal } = await fixture();
    const cashierUser = await raw.user.create({
      data: {
        role: 'cashier',
        ownerId: business.ownerId,
        pinHash: await hashSecret('654321'),
      },
    });
    await raw.staffProfile.create({
      data: {
        userId: cashierUser.id,
        businessId: business.id,
        name: 'Ana',
        status: 'active',
        branches: { create: [{ branchId: branch.id }] },
      },
    });
    const roster = await device(
      request(server()).get('/v1/pos/operators'),
    ).expect(200);
    expect(roster.body).toMatchObject([
      { userId: ownerUser.id, role: 'owner' },
      { userId: cashierUser.id, name: 'Ana', role: 'cashier' },
    ]);

    const unlocked = await device(
      request(server()).post('/v1/pos/operators/unlock'),
    )
      .send({ userId: ownerUser.id, pin: '123456' })
      .expect(201);
    expect(unlocked.body.operator).toMatchObject({
      userId: ownerUser.id,
      role: 'owner',
    });
    expect(unlocked.body.token).toEqual(expect.any(String));
    const session = await raw.operatorSession.findFirstOrThrow({
      where: { terminalId: terminal.id },
    });
    expect(session.tokenHash).not.toBe(unlocked.body.token);
    const current = await device(
      request(server()).get('/v1/pos/operators/current'),
    )
      .set('X-Operator-Token', unlocked.body.token as string)
      .expect(200);
    expect(current.body.userId).toBe(ownerUser.id);
    await device(request(server()).post('/v1/pos/operators/lock'))
      .set('X-Operator-Token', unlocked.body.token as string)
      .expect(200);
    await device(request(server()).get('/v1/pos/operators/current'))
      .set('X-Operator-Token', unlocked.body.token as string)
      .expect(401);
  });

  it('requires a human session to open a shift and attributes the drawer to that operator', async () => {
    const { ownerUser, terminal } = await fixture();
    await device(request(server()).post('/v1/pos/shifts'))
      .send({ openingCashC: 1000 })
      .expect(401);
    const unlocked = await device(
      request(server()).post('/v1/pos/operators/unlock'),
    )
      .send({ userId: ownerUser.id, pin: '123456' })
      .expect(201);
    const opened = await device(request(server()).post('/v1/pos/shifts'))
      .set('X-Operator-Token', unlocked.body.token as string)
      .send({ openingCashC: 1000 })
      .expect(201);
    const shift = await raw.shift.findUniqueOrThrow({
      where: { id: opened.body.id as string },
    });
    expect(shift.terminalId).toBe(terminal.id);
    expect(shift.operatorUserId).toBe(ownerUser.id);
  });

  it('filters cashier activity by the authenticated human, not a requested user ID', async () => {
    const f = await fixture();
    const cashier = await raw.user.create({
      data: {
        role: 'cashier',
        ownerId: f.owner.id,
        pinHash: await hashSecret('654321'),
      },
    });
    await raw.staffProfile.create({
      data: {
        userId: cashier.id,
        businessId: f.business.id,
        name: 'Ana',
        status: 'active',
        branches: { create: [{ branchId: f.branch.id }] },
      },
    });
    const own = await raw.shift.create({
      data: {
        terminalId: f.terminal.id,
        branchId: f.branch.id,
        operatorUserId: cashier.id,
        openingCash: 1000,
        openedAt: new Date(),
        closedAt: new Date(),
        closingCash: 900,
        expectedCash: 1000,
      },
    });
    await raw.shift.create({
      data: {
        terminalId: f.terminal.id,
        branchId: f.branch.id,
        operatorUserId: f.ownerUser.id,
        openingCash: 1000,
        openedAt: new Date(),
        closedAt: new Date(),
        closingCash: 1100,
        expectedCash: 1000,
      },
    });
    const otherBranch = await raw.branch.create({
      data: {
        businessId: f.business.id,
        name: 'Other',
        code: 'OTHER',
        address: 'Street',
      },
    });
    const otherTerminal = await raw.terminal.create({
      data: { branchId: otherBranch.id, name: 'Other till', code: 'T-2' },
    });
    await raw.shift.create({
      data: {
        terminalId: otherTerminal.id,
        branchId: otherBranch.id,
        operatorUserId: cashier.id,
        openingCash: 1000,
        openedAt: new Date(),
        closedAt: new Date(),
        closingCash: 1100,
        expectedCash: 1000,
      },
    });
    for (const [branchId, terminalId, operatorUserId, receiptNo] of [
      [f.branch.id, f.terminal.id, cashier.id, 'OWN'],
      [f.branch.id, f.terminal.id, f.ownerUser.id, 'OWNER'],
      [otherBranch.id, otherTerminal.id, cashier.id, 'OTHER'],
    ]) {
      await raw.sale.create({
        data: {
          branchId,
          terminalId,
          operatorUserId,
          receiptNo,
          orderType: 'takeout',
          status: 'completed',
          subtotal: 100,
          tax: 0,
          total: 100,
          createdAtDevice: new Date(),
          draft: {},
        },
      });
    }
    await device(request(server()).get('/v1/pos/operators/activity')).expect(
      401,
    );
    const unlocked = await device(
      request(server()).post('/v1/pos/operators/unlock'),
    )
      .send({ userId: cashier.id, pin: '654321' })
      .expect(201);
    const result = await device(
      request(server()).get(
        `/v1/pos/operators/activity?userId=${f.ownerUser.id}`,
      ),
    )
      .set('X-Operator-Token', unlocked.body.token as string)
      .expect(200);
    expect(result.body.shifts).toHaveLength(1);
    expect(result.body.shifts[0]).toMatchObject({
      id: own.id,
      operatorUserId: cashier.id,
      overShortC: -100,
    });
    expect(result.body.sales).toHaveLength(1);
    expect(result.body.sales[0]).toMatchObject({
      receiptNo: 'OWN',
      operatorUserId: cashier.id,
      totalC: 100,
    });
  });

  it('requires a human session for every terminal write route', async () => {
    await fixture();
    for (const path of [
      '/v1/pos/shifts/current/cash-movements',
      '/v1/pos/shifts/current/close',
      '/v1/pos/sales',
      '/v1/pos/sales/00000000-0000-4000-8000-000000000001/void',
      '/v1/pos/sales/00000000-0000-4000-8000-000000000001/refund',
      '/v1/pos/stock/adjustments',
    ]) {
      await device(request(server()).post(path)).send({}).expect(401);
    }
  });

  it('requires a temporary cashier PIN change before unlock and rejects reuse', async () => {
    const { business, branch } = await fixture();
    const user = await raw.user.create({
      data: { role: 'cashier', ownerId: business.ownerId },
    });
    await raw.staffProfile.create({
      data: {
        userId: user.id,
        businessId: business.id,
        name: 'Ana',
        branches: { create: [{ branchId: branch.id }] },
      },
    });
    const temporaryPin = '112233';
    await raw.staffChallenge.create({
      data: {
        userId: user.id,
        kind: 'cashier_setup',
        pinHash: await hashSecret(temporaryPin),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    await device(request(server()).post('/v1/pos/operators/unlock'))
      .send({ userId: user.id, pin: temporaryPin })
      .expect(422);
    await device(request(server()).post('/v1/pos/operators/setup-pin'))
      .send({ userId: user.id, temporaryPin, newPin: temporaryPin })
      .expect(422);
    const setup = await device(
      request(server()).post('/v1/pos/operators/setup-pin'),
    )
      .send({ userId: user.id, temporaryPin, newPin: '445566' })
      .expect(201);
    expect(setup.body.operator).toMatchObject({
      userId: user.id,
      role: 'cashier',
    });
    expect(
      (await raw.user.findUniqueOrThrow({ where: { id: user.id } })).pinHash,
    ).not.toBe('445566');
    await device(request(server()).post('/v1/pos/operators/setup-pin'))
      .send({ userId: user.id, temporaryPin, newPin: '778899' })
      .expect(400);
  });

  it('offers terminal PIN recovery to a pending manager but not initial manager setup', async () => {
    const { business, branch } = await fixture();
    const pending = await raw.user.create({
      data: {
        role: 'manager',
        ownerId: business.ownerId,
        email: 'pending@example.test',
      },
    });
    const reset = await raw.user.create({
      data: {
        role: 'manager',
        ownerId: business.ownerId,
        email: 'reset@example.test',
        passwordHash: await hashSecret('manager-password'),
      },
    });
    for (const user of [pending, reset]) {
      await raw.staffProfile.create({
        data: {
          userId: user.id,
          businessId: business.id,
          name: user.id,
          status: 'pending',
          branches: { create: [{ branchId: branch.id }] },
        },
      });
      await raw.staffChallenge.create({
        data: {
          userId: user.id,
          kind: user.id === reset.id ? 'pin_reset' : 'manager_setup',
          pinHash: await hashSecret('112233'),
          expiresAt: new Date(Date.now() + 900_000),
        },
      });
    }
    const roster = await device(
      request(server()).get('/v1/pos/operators'),
    ).expect(200);
    expect(roster.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: reset.id,
          role: 'manager',
          requiresSetup: true,
        }),
      ]),
    );
    expect(roster.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: pending.id })]),
    );
    await device(request(server()).post('/v1/pos/operators/setup-pin'))
      .send({ userId: reset.id, temporaryPin: '112233', newPin: '445566' })
      .expect(201);
  });

  it('expires an idle session and rejects a different terminal or removed branch assignment', async () => {
    const { ownerUser, business, branch, terminal } = await fixture();
    const user = await raw.user.create({
      data: {
        role: 'cashier',
        ownerId: business.ownerId,
        pinHash: await hashSecret('654321'),
      },
    });
    const profile = await raw.staffProfile.create({
      data: {
        userId: user.id,
        businessId: business.id,
        name: 'Ana',
        status: 'active',
        branches: { create: [{ branchId: branch.id }] },
      },
    });
    const unlocked = await device(
      request(server()).post('/v1/pos/operators/unlock'),
    )
      .send({ userId: user.id, pin: '654321' })
      .expect(201);
    const session = await raw.operatorSession.findFirstOrThrow({
      where: { userId: user.id },
    });
    await raw.operatorSession.update({
      where: { id: session.id },
      data: { lastActivityAt: new Date(Date.now() - 6 * 60_000) },
    });
    await device(request(server()).get('/v1/pos/operators/current'))
      .set('X-Operator-Token', unlocked.body.token as string)
      .expect(401);

    const fresh = await device(
      request(server()).post('/v1/pos/operators/unlock'),
    )
      .send({ userId: user.id, pin: '654321' })
      .expect(201);
    const second = await raw.terminal.create({
      data: {
        branchId: branch.id,
        name: 'Second till',
        code: 'T-2',
        deviceTokenHash: createHash('sha256')
          .update('other-device')
          .digest('hex'),
      },
    });
    expect(second.id).not.toBe(terminal.id);
    await request(server())
      .get('/v1/pos/operators/current')
      .set('Authorization', 'Bearer other-device')
      .set('X-Operator-Token', fresh.body.token as string)
      .expect(401);
    await raw.staffBranch.deleteMany({ where: { staffProfileId: profile.id } });
    await device(request(server()).get('/v1/pos/operators/current'))
      .set('X-Operator-Token', fresh.body.token as string)
      .expect(401);
    expect(ownerUser.id).toBeDefined();
  });

  it('directs an owner without a PIN to portal settings and logs the claimed identity on wrong PIN', async () => {
    const { ownerUser, terminal } = await fixture(null);
    const roster = await device(
      request(server()).get('/v1/pos/operators'),
    ).expect(200);
    expect(roster.body[0].requiresSetup).toBe(true);
    await device(request(server()).post('/v1/pos/operators/unlock'))
      .send({ userId: ownerUser.id, pin: '123456' })
      .expect(422);
    expect(await raw.operatorSession.count()).toBe(0);
    await raw.user.update({
      where: { id: ownerUser.id },
      data: { pinHash: await hashSecret('123456') },
    });
    await device(request(server()).post('/v1/pos/operators/unlock'))
      .send({ userId: ownerUser.id, pin: '000000' })
      .expect(403);
    const audit = await raw.auditLog.findFirstOrThrow({
      where: { action: 'auth.pin_failure' },
    });
    expect(audit.entityId).toBe(ownerUser.id);
    expect(audit.metadata).toMatchObject({
      attemptedBy: ownerUser.id,
      terminalId: terminal.id,
    });
  });

  it('rejects an absolute-expired session, deactivation, device revocation and wrong shift operator', async () => {
    const { ownerUser, business, branch, terminal } = await fixture();
    const user = await raw.user.create({
      data: {
        role: 'cashier',
        ownerId: business.ownerId,
        pinHash: await hashSecret('654321'),
      },
    });
    const profile = await raw.staffProfile.create({
      data: {
        userId: user.id,
        businessId: business.id,
        name: 'Ana',
        status: 'active',
        branches: { create: [{ branchId: branch.id }] },
      },
    });
    const first = await device(
      request(server()).post('/v1/pos/operators/unlock'),
    )
      .send({ userId: user.id, pin: '654321' })
      .expect(201);
    await raw.operatorSession.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await device(request(server()).get('/v1/pos/operators/current'))
      .set('X-Operator-Token', first.body.token as string)
      .expect(401);

    const second = await device(
      request(server()).post('/v1/pos/operators/unlock'),
    )
      .send({ userId: user.id, pin: '654321' })
      .expect(201);
    await raw.staffProfile.update({
      where: { id: profile.id },
      data: { status: 'deactivated' },
    });
    await device(request(server()).get('/v1/pos/operators/current'))
      .set('X-Operator-Token', second.body.token as string)
      .expect(401);
    await raw.staffProfile.update({
      where: { id: profile.id },
      data: { status: 'active' },
    });

    await raw.shift.create({
      data: {
        branchId: branch.id,
        terminalId: terminal.id,
        openedAt: new Date(),
        openingCash: 0,
        operatorUserId: ownerUser.id,
      },
    });
    await device(request(server()).post('/v1/pos/operators/unlock'))
      .send({ userId: user.id, pin: '654321' })
      .expect(403);
    const ownerSession = await device(
      request(server()).post('/v1/pos/operators/unlock'),
    )
      .send({ userId: ownerUser.id, pin: '123456' })
      .expect(201);
    await raw.terminal.update({
      where: { id: terminal.id },
      data: { deviceTokenHash: null },
    });
    await device(request(server()).get('/v1/pos/operators/current'))
      .set('X-Operator-Token', ownerSession.body.token as string)
      .expect(401);
  });

  it.each(['deactivation', 'PIN change', 'device pairing'])(
    'cannot create a session when %s commits while unlock waits',
    async (changed) => {
      const { business, branch, terminal } = await fixture();
      const user = await raw.user.create({
        data: {
          role: 'cashier',
          ownerId: business.ownerId,
          pinHash: await hashSecret('654321'),
        },
      });
      const profile = await raw.staffProfile.create({
        data: {
          userId: user.id,
          businessId: business.id,
          name: 'Ana',
          status: 'active',
          branches: { create: [{ branchId: branch.id }] },
        },
      });
      // Keep TerminalGuard's liveness write from being the lock contender; the
      // request must reach issueSession before deactivation commits.
      await raw.terminal.update({
        where: { id: terminal.id },
        data: { lastSeenAt: new Date() },
      });
      const replacementHash = await hashSecret('998877');
      let release!: () => void;
      let locked!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const transaction = raw.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM terminals WHERE id = ${terminal.id}::uuid FOR UPDATE`;
          locked();
          await hold;
          if (changed === 'deactivation') {
            await tx.staffProfile.update({
              where: { id: profile.id },
              data: { status: 'deactivated' },
            });
          } else if (changed === 'PIN change') {
            await tx.user.update({
              where: { id: user.id },
              data: { pinHash: replacementHash },
            });
          } else {
            await tx.terminal.update({
              where: { id: terminal.id },
              data: { deviceTokenHash: 'replacement-hash' },
            });
          }
        },
        { timeout: 20000 },
      );
      await ready;
      const pending = device(request(server()).post('/v1/pos/operators/unlock'))
        .send({ userId: user.id, pin: '654321' })
        .then((response) => response);
      let observedWait = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const rows = await raw.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*)::bigint AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE 'SELECT id FROM terminals%'
      `;
        if (rows[0]?.waiting > 0n) {
          observedWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await transaction;
      expect(observedWait).toBe(true);
      const response = await pending;
      expect(response.status).toBe(401);
      expect(
        await raw.operatorSession.count({
          where: { userId: user.id, revokedAt: null },
        }),
      ).toBe(0);
    },
    15000,
  );
});
