/*
 * Task 18 — POS shifts e2e (TDD on the X/Z math).
 *
 * All endpoints are TerminalGuard-protected. Sales are seeded via the raw client
 * (Task 19's completeSale doesn't exist yet — the ordering note in the plan) so we
 * can reproduce the design's Z arithmetic exactly:
 *   opening 200000, cash sales (net) 7200, cash-in 100000, cash-out 75000
 *   → expectedCash 232200; close counting 232000 → overShort −200.
 * The sold set = non-voided sales of the shift (a refunded sale still counts as
 * sold and is offset separately by the refund); voided sales are excluded.
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
import { PrismaClient, SaleStatus, PaymentMethod } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hashSecret } from '../src/auth/hashing';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

let seq = 0;

describe('POS shifts (e2e)', () => {
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

  /** Seed owner→business→branch→terminal directly; return the device token + ids. */
  async function seedTerminal(): Promise<{
    deviceToken: string;
    operatorToken: string;
    operatorUserId: string;
    branchId: string;
    terminalId: string;
  }> {
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
    const terminal = await raw.terminal.create({
      data: {
        branchId: branch.id,
        name: 'Register 1',
        code: 'T1',
        deviceTokenHash: sha256(deviceToken),
      },
    });
    const unlocked = await request(server())
      .post('/v1/pos/operators/unlock')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ userId: ownerUser.id, pin: '123456' })
      .expect(201);
    return {
      deviceToken,
      operatorToken: unlocked.body.token as string,
      operatorUserId: ownerUser.id,
      branchId: branch.id,
      terminalId: terminal.id,
    };
  }

  /** Seed a completed/voided/refunded sale (+ one payment) via the raw client. */
  it('requires a human for live drawer totals and redacts blind cash before close only', async () => {
    const w = await seedTerminal();
    const business = await raw.branch.findUniqueOrThrow({
      where: { id: w.branchId },
    });
    await raw.business.update({
      where: { id: business.businessId },
      data: { blindCloseEnabled: true },
    });
    const opened = await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', `Bearer ${w.deviceToken}`)
      .set('X-Operator-Token', w.operatorToken)
      .send({ openingCashC: 10000 })
      .expect(201);
    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set('Authorization', `Bearer ${w.deviceToken}`)
      .set('X-Operator-Token', w.operatorToken)
      .send({ type: 'in', amountC: 2000, reason: 'Change fund' })
      .expect(201);
    const anonymous = await request(server())
      .get('/v1/pos/shifts/current')
      .set('Authorization', `Bearer ${w.deviceToken}`)
      .expect(200);
    expect(anonymous.body.id).toBe(opened.body.id);
    expect(anonymous.body.operatorUserId).toBe(w.operatorUserId);
    expect(anonymous.body.openingCashC).toBeNull();
    expect(anonymous.body.cashMovements).toEqual([]);
    const denied = await request(server())
      .get('/v1/pos/shifts/current/totals')
      .set('Authorization', `Bearer ${w.deviceToken}`)
      .expect(401);
    expect(denied.body.code).toBe('operator_unauthorized');
    const live = await request(server())
      .get('/v1/pos/shifts/current/totals')
      .set('Authorization', `Bearer ${w.deviceToken}`)
      .set('X-Operator-Token', w.operatorToken)
      .expect(200);
    expect(live.body.blindCloseEnabled).toBe(true);
    for (const key of [
      'expectedCashC',
      'cashSalesC',
      'cashRefundsC',
      'cashInC',
      'cashOutC',
    ])
      expect(live.body[key]).toBeNull();
    expect(live.body.byMethod.cash).toBeNull();
    const closed = await request(server())
      .post('/v1/pos/shifts/current/close')
      .set('Authorization', `Bearer ${w.deviceToken}`)
      .set('X-Operator-Token', w.operatorToken)
      .send({ countedCashC: 11900 })
      .expect(200);
    expect(closed.body.expectedCashC).toBe(12000);
    expect(closed.body.cashInC).toBe(2000);
    expect(closed.body.overShortC).toBe(-100);
  });

  /** Seed a completed/voided/refunded sale (+ one payment) via the raw client. */
  async function seedSale(opts: {
    branchId: string;
    terminalId: string;
    shiftId: string | null;
    receiptNo: string;
    status: SaleStatus;
    method: PaymentMethod;
    total: number;
    serviceCharge?: number;
    scPwdDiscount?: number;
    refundShiftId?: string | null;
  }): Promise<void> {
    await raw.sale.create({
      data: {
        branchId: opts.branchId,
        terminalId: opts.terminalId,
        shiftId: opts.shiftId,
        receiptNo: opts.receiptNo,
        orderType: 'takeout',
        status: opts.status,
        subtotal: opts.total,
        serviceCharge: opts.serviceCharge ?? 0,
        scPwdDiscount: opts.scPwdDiscount ?? 0,
        tax: 0,
        total: opts.total,
        createdAtDevice: new Date(),
        draft: {},
        ...(opts.status === 'refunded'
          ? {
              refundedAt: new Date(),
              refundShiftId: opts.refundShiftId ?? null,
            }
          : {}),
        ...(opts.status === 'voided' ? { voidedAt: new Date() } : {}),
        payments: {
          create: {
            method: opts.method,
            amount: opts.total,
            tendered: opts.total,
            change: 0,
          },
        },
      },
    });
  }

  const bearer = (deviceToken: string) => `Bearer ${deviceToken}`;

  async function staff(
    t: Awaited<ReturnType<typeof seedTerminal>>,
    role: 'manager' | 'cashier',
  ) {
    const ownerUser = await raw.user.findUniqueOrThrow({
      where: { id: t.operatorUserId },
    });
    const branch = await raw.branch.findUniqueOrThrow({
      where: { id: t.branchId },
    });
    const user = await raw.user.create({
      data: {
        role,
        ownerId: ownerUser.ownerId,
        pinHash: await hashSecret('654321'),
        ...(role === 'manager' ? { email: `manager-${seq}@example.test` } : {}),
      },
    });
    const profile = await raw.staffProfile.create({
      data: {
        userId: user.id,
        businessId: branch.businessId,
        name: role,
        status: 'active',
        branches: { create: [{ branchId: branch.id }] },
      },
    });
    return { user, profile };
  }

  async function cashierShift(t: Awaited<ReturnType<typeof seedTerminal>>) {
    const person = await staff(t, 'cashier');
    const unlocked = await request(server())
      .post('/v1/pos/operators/unlock')
      .set('Authorization', bearer(t.deviceToken))
      .send({ userId: person.user.id, pin: '654321' })
      .expect(201);
    const opened = await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', unlocked.body.token as string)
      .send({ openingCashC: 10000 })
      .expect(201);
    return { ...person, shiftId: opened.body.id as string };
  }

  it('emergency-closes an unavailable cashier drawer without changing its operator or creating a session', async () => {
    const t = await seedTerminal();
    const cashier = await cashierShift(t);
    await raw.staffProfile.update({
      where: { id: cashier.profile.id },
      data: { status: 'deactivated' },
    });
    const sessionsBefore = await raw.operatorSession.count();
    const closed = await request(server())
      .post('/v1/pos/shifts/current/emergency-close')
      .set('Authorization', bearer(t.deviceToken))
      .send({
        countedCashC: 9900,
        reason: 'Cashier access revoked',
        approval: { approverUserId: t.operatorUserId, pin: '123456' },
      })
      .expect(200);
    expect(closed.body.overShortC).toBe(-100);
    expect(closed.body.operatorUserId).toBe(cashier.user.id);
    expect(closed.body.closedByUserId).toBe(t.operatorUserId);
    expect(closed.body.emergencyCloseReason).toBe('Cashier access revoked');
    const shift = await raw.shift.findUniqueOrThrow({
      where: { id: cashier.shiftId },
    });
    expect(shift.operatorUserId).toBe(cashier.user.id);
    expect(shift.closedByUserId).toBe(t.operatorUserId);
    expect(shift.emergencyCloseReason).toBe('Cashier access revoked');
    expect(await raw.operatorSession.count()).toBe(sessionsBefore);
    await request(server())
      .post('/v1/pos/shifts/current/emergency-close')
      .set('Authorization', bearer(t.deviceToken))
      .send({
        countedCashC: 9900,
        reason: 'Again',
        approval: { approverUserId: t.operatorUserId, pin: '123456' },
      })
      .expect(422);
  });

  it('requires a reason and an eligible approver PIN; an active cashier cannot be displaced', async () => {
    const t = await seedTerminal();
    const cashier = await cashierShift(t);
    const close = (
      approverUserId: string,
      pin: string,
      reason = 'Access revoked',
    ) =>
      request(server())
        .post('/v1/pos/shifts/current/emergency-close')
        .set('Authorization', bearer(t.deviceToken))
        .send({
          countedCashC: 10000,
          reason,
          approval: { approverUserId, pin },
        });
    await close(t.operatorUserId, '123456', '   ').expect(422);
    await close(t.operatorUserId, '000000').expect(403);
    await close(cashier.user.id, '654321').expect(403);
    await close(t.operatorUserId, '123456').expect(403);
    await raw.staffProfile.update({
      where: { id: cashier.profile.id },
      data: { status: 'deactivated' },
    });
    const manager = await staff(t, 'manager');
    await raw.staffBranch.deleteMany({
      where: { staffProfileId: manager.profile.id },
    });
    await close(manager.user.id, '654321').expect(403);
    await raw.staffBranch.create({
      data: { staffProfileId: manager.profile.id, branchId: t.branchId },
    });
    await close(manager.user.id, '654321').expect(200);
    expect(
      (await raw.shift.findUniqueOrThrow({ where: { id: cashier.shiftId } }))
        .closedByUserId,
    ).toBe(manager.user.id);
  });

  it('can recover an unattributed legacy shift without inventing its original operator', async () => {
    const t = await seedTerminal();
    const legacy = await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date(),
        openingCash: 5000,
      },
    });
    await request(server())
      .post('/v1/pos/shifts/current/emergency-close')
      .set('Authorization', bearer(t.deviceToken))
      .send({
        countedCashC: 5000,
        reason: 'Legacy drawer reconciliation',
        approval: { approverUserId: t.operatorUserId, pin: '123456' },
      })
      .expect(200);
    const shift = await raw.shift.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    expect(shift.operatorUserId).toBeNull();
    expect(shift.closedByUserId).toBe(t.operatorUserId);
  });

  it('rejects unauthenticated access (401)', async () => {
    await request(server()).get('/v1/pos/shifts/current').expect(401);
    await request(server())
      .post('/v1/pos/shifts')
      .send({ openingCashC: 1000 })
      .expect(401);
  });

  it('current shift is null before any shift is opened', async () => {
    const t = await seedTerminal();
    const res = await request(server())
      .get('/v1/pos/shifts/current')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .expect(200);
    expect(res.body).toBeNull();
  });

  it('opens a shift, rejects a second open (422), and reads it back', async () => {
    const t = await seedTerminal();
    const opened = await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ openingCashC: 200000 })
      .expect(201);
    expect(opened.body.openingCashC).toBe(200000);
    expect(opened.body.operatorUserId).toBe(t.operatorUserId);
    expect(opened.body.closedAt).toBeNull();
    expect(opened.body.cashMovements).toEqual([]);
    expect(typeof opened.body.openedAt).toBe('string');

    // Double-open on the same terminal → 422.
    await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ openingCashC: 5000 })
      .expect(422);

    const current = await request(server())
      .get('/v1/pos/shifts/current')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .expect(200);
    expect(current.body.id).toBe(opened.body.id);
  });

  it('records cash movements (in/out) and echoes them on the current shift', async () => {
    const t = await seedTerminal();
    const opened = await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ openingCashC: 200000 })
      .expect(201);

    const mIn = await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ type: 'in', amountC: 100000, reason: 'float top-up' })
      .expect(201);
    expect(mIn.body).toMatchObject({
      type: 'in',
      amountC: 100000,
      reason: 'float top-up',
      operatorUserId: t.operatorUserId,
    });
    expect(typeof mIn.body.at).toBe('string');
    const movement = await raw.shiftCashMovement.findUniqueOrThrow({
      where: { id: mIn.body.id as string },
    });
    expect(movement.operatorUserId).toBe(t.operatorUserId);

    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ type: 'out', amountC: 75000, reason: 'petty cash' })
      .expect(201);

    const current = await request(server())
      .get('/v1/pos/shifts/current')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .expect(200);
    expect(current.body.id).toBe(opened.body.id);
    expect(current.body.cashMovements).toHaveLength(2);
    expect(current.body.cashMovements.map((m: any) => m.type)).toEqual([
      'in',
      'out',
    ]);

    // Bad cash-movement inputs → 422.
    for (const bad of [
      { type: 'in', amountC: 0, reason: 'x' }, // amount must be > 0
      { type: 'out', amountC: 100, reason: '   ' }, // reason required
      { type: 'sideways', amountC: 100, reason: 'x' }, // bad type
    ]) {
      await request(server())
        .post('/v1/pos/shifts/current/cash-movements')
        .set('Authorization', bearer(t.deviceToken))
        .set('X-Operator-Token', t.operatorToken)
        .send(bad)
        .expect(422);
    }
  });

  it('computes X totals with the FE math (void excluded, refund offsets)', async () => {
    const t = await seedTerminal();
    const opened = await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ openingCashC: 200000 })
      .expect(201);
    const shiftId = opened.body.id;

    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ type: 'in', amountC: 100000, reason: 'float top-up' })
      .expect(201);
    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ type: 'out', amountC: 75000, reason: 'petty cash' })
      .expect(201);

    const common = { branchId: t.branchId, terminalId: t.terminalId };
    // A: completed cash sale (sold).
    await seedSale({
      ...common,
      shiftId,
      receiptNo: 'R-A',
      status: 'completed',
      method: 'cash',
      total: 7200,
      serviceCharge: 300,
      scPwdDiscount: 150,
    });
    // B: voided cash sale (excluded from sold; counts as void).
    await seedSale({
      ...common,
      shiftId,
      receiptNo: 'R-B',
      status: 'voided',
      method: 'cash',
      total: 5000,
    });
    // C: refunded cash sale of THIS shift (still sold; refund offsets separately).
    await seedSale({
      ...common,
      shiftId,
      receiptNo: 'R-C',
      status: 'refunded',
      method: 'cash',
      total: 3000,
      serviceCharge: 100,
      scPwdDiscount: 50,
      refundShiftId: shiftId,
    });

    const res = await request(server())
      .get('/v1/pos/shifts/current/totals')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .expect(200);
    const x = res.body;

    // sold = {A, C}; voided = {B}; refunds = {C}
    expect(x.grossC).toBe(10200); // 7200 + 3000
    expect(x.saleCount).toBe(2);
    expect(x.byMethod.cash).toBe(10200);
    expect(x.byMethod.card).toBe(0);
    expect(x.voidCount).toBe(1);
    expect(x.voidAmountC).toBe(5000);
    expect(x.refundCount).toBe(1);
    expect(x.refundAmountC).toBe(3000);
    expect(x.scPwdDiscountC).toBe(200); // 150 + 50
    expect(x.serviceChargeC).toBe(400); // 300 + 100
    expect(x.cashSalesC).toBe(10200);
    expect(x.cashRefundsC).toBe(3000);
    expect(x.cashInC).toBe(100000);
    expect(x.cashOutC).toBe(75000);
    // 200000 + 10200 − 3000 + 100000 − 75000
    expect(x.expectedCashC).toBe(232200);
  });

  it('closes the shift and returns the Z-report (overShort = counted − expected)', async () => {
    const t = await seedTerminal();
    const opened = await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ openingCashC: 200000 })
      .expect(201);
    const shiftId = opened.body.id;

    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ type: 'in', amountC: 100000, reason: 'float top-up' })
      .expect(201);
    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ type: 'out', amountC: 75000, reason: 'petty cash' })
      .expect(201);
    await seedSale({
      branchId: t.branchId,
      terminalId: t.terminalId,
      shiftId,
      receiptNo: 'R-1',
      status: 'completed',
      method: 'cash',
      total: 7200,
    });

    const z = await request(server())
      .post('/v1/pos/shifts/current/close')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ countedCashC: 232000 })
      .expect(200);

    expect(z.body.shiftId).toBe(shiftId);
    expect(z.body.expectedCashC).toBe(232200);
    expect(z.body.countedCashC).toBe(232000);
    expect(z.body.overShortC).toBe(-200);
    expect(z.body.openingCashC).toBe(200000);
    expect(z.body.branchCode).toBe('MN');
    expect(z.body.terminalCode).toBe('T1');
    expect(typeof z.body.closedAt).toBe('string');
    expect(z.body.cashSalesC).toBe(7200);

    // Persisted: closingCash + expectedCash stamped, current shift now null.
    const row = await raw.shift.findUniqueOrThrow({ where: { id: shiftId } });
    expect(row.closingCash).toBe(232000);
    expect(row.expectedCash).toBe(232200);
    expect(row.closedAt).not.toBeNull();
    expect(row.closedByUserId).toBe(t.operatorUserId);

    const current = await request(server())
      .get('/v1/pos/shifts/current')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .expect(200);
    expect(current.body).toBeNull();
  });

  it('rejects cash-movement / totals / close when no shift is open (422)', async () => {
    const t = await seedTerminal();
    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ type: 'in', amountC: 100, reason: 'x' })
      .expect(422);
    await request(server())
      .get('/v1/pos/shifts/current/totals')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .expect(422);
    await request(server())
      .post('/v1/pos/shifts/current/close')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ countedCashC: 1000 })
      .expect(422);
  });

  it('validates open/close amounts (422 on negative / non-integer)', async () => {
    const t = await seedTerminal();
    await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ openingCashC: -1 })
      .expect(422);
    await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ openingCashC: 12.5 })
      .expect(422);

    // Open cleanly, then a negative counted-cash close → 422.
    await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ openingCashC: 0 })
      .expect(201);
    await request(server())
      .post('/v1/pos/shifts/current/close')
      .set('Authorization', bearer(t.deviceToken))
      .set('X-Operator-Token', t.operatorToken)
      .send({ countedCashC: -5 })
      .expect(422);
  });
});
