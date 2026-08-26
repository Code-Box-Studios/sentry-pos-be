/*
 * Task 20 — POS void + refund e2e (PIN gate).
 *
 * Sales are created through the real Task 19 completeSale endpoint so restoration
 * mirrors the sale's own stock_movements. Void is ungated but only while the
 * sale's shift is open; refund is PIN-gated (LockoutService) and attributes
 * refund_shift_id only when the refund happens in the sale's own open shift.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashSecret } from '../src/auth/hashing';
import { computeTotals } from '../src/common/totals/totals';
import type { Cart, CartLine } from '../src/common/totals/cart';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const TAX_RATE = 0.12;
const SC_RATE = 0.05;
const PIN = '4921';

let seq = 0;

describe('POS void + refund (e2e)', () => {
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

  /** owner(+user with refund PIN)→business→branch→terminal→open shift, product P1 stock 5. */
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
    await raw.user.create({
      data: {
        email: `user-${seq}-${Date.now()}@test.com`,
        role: 'owner',
        ownerId: owner.id,
        passwordHash: 'x',
        pinHash: await hashSecret(PIN),
      },
    });
    const business = await raw.business.create({
      data: {
        ownerId: owner.id,
        name: 'Kape',
        type: 'fnb',
        currency: 'PHP',
        taxRate: String(TAX_RATE),
        serviceChargeRate: String(SC_RATE),
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
        receiptSeq: 1,
      },
    });
    const shift = await raw.shift.create({
      data: {
        branchId: branch.id,
        terminalId: terminal.id,
        openedAt: new Date(),
        openingCash: 200000,
      },
    });
    const category = await raw.category.create({
      data: { businessId: business.id, name: 'Coffee', sortOrder: 1 },
    });
    const p1 = await raw.product.create({
      data: {
        businessId: business.id,
        categoryId: category.id,
        name: 'Espresso',
        price: 8500,
        cost: 3000,
        trackStock: true,
      },
    });
    await raw.branchStock.create({
      data: { branchId: branch.id, productId: p1.id, qty: '5' },
    });

    return {
      owner,
      deviceToken,
      branchId: branch.id,
      terminalId: terminal.id,
      shiftId: shift.id,
      p1,
    };
  }

  function saleLine(productId: string): CartLine {
    return {
      id: randomUUID(),
      productId,
      variantId: null,
      name: 'Espresso',
      soldBy: 'unit',
      qty: 2,
      unitPriceC: 8500,
      modifiers: [],
      discount: null,
      scPwdMarked: false,
      trackStock: true,
    };
  }

  /** Create a completed cash sale via the real endpoint; return CompletedSale. */
  async function makeSale(w: {
    deviceToken: string;
    shiftId: string;
    p1: { id: string };
  }) {
    const cart: Cart = {
      id: randomUUID(),
      orderType: 'takeout',
      lines: [saleLine(w.p1.id)],
      orderDiscount: null,
      scPwd: null,
    };
    const totals = computeTotals(cart, {
      taxRate: TAX_RATE,
      serviceChargeRate: SC_RATE,
    });
    seq += 1;
    const draft = {
      id: cart.id,
      receiptNo: `R-${seq}`,
      shiftId: w.shiftId,
      orderType: cart.orderType,
      lines: cart.lines,
      orderDiscount: null,
      scPwd: null,
      totals,
      payment: {
        id: randomUUID(),
        method: 'cash',
        referenceNo: null,
        amountC: totals.totalC,
        tenderedC: totals.totalC,
        changeC: 0,
      },
      createdAtDevice: new Date().toISOString(),
    };
    const res = await request(server())
      .post('/v1/pos/sales')
      .set('Authorization', bearer(w.deviceToken))
      .send(draft)
      .expect(201);
    return res.body;
  }

  const stockQty = async (branchId: string, productId: string) => {
    const level = await raw.branchStock.findFirstOrThrow({
      where: { branchId, productId, variantId: null },
    });
    return level.qty.toString();
  };

  // ------------------------------------------------------------------ void

  it('voids a completed sale: flags it and restores stock', async () => {
    const w = await seedWorld();
    const sale = await makeSale(w);
    expect(await stockQty(w.branchId, w.p1.id)).toBe('3'); // 5 − 2

    const res = await request(server())
      .post(`/v1/pos/sales/${sale.id}/void`)
      .set('Authorization', bearer(w.deviceToken))
      .send({ reason: 'wrong item' })
      .expect(200);
    expect(res.body.status).toBe('voided');
    expect(res.body.statusReason).toBe('wrong item');
    expect(typeof res.body.voidedAt).toBe('string');

    expect(await stockQty(w.branchId, w.p1.id)).toBe('5'); // restored
    const voidMoves = await raw.stockMovement.findMany({
      where: { refId: sale.id, type: 'void' },
    });
    expect(voidMoves).toHaveLength(1);
    expect(voidMoves[0].qtyDelta.toString()).toBe('2'); // +2 restored
  });

  it('rejects void once the sale’s shift is closed (422), stock untouched', async () => {
    const w = await seedWorld();
    const sale = await makeSale(w);
    // Close the shift.
    await request(server())
      .post('/v1/pos/shifts/current/close')
      .set('Authorization', bearer(w.deviceToken))
      .send({ countedCashC: 0 })
      .expect(200);

    await request(server())
      .post(`/v1/pos/sales/${sale.id}/void`)
      .set('Authorization', bearer(w.deviceToken))
      .send({ reason: 'too late' })
      .expect(422);
    expect(await stockQty(w.branchId, w.p1.id)).toBe('3'); // not restored
  });

  it('rejects a void with an empty reason (422)', async () => {
    const w = await seedWorld();
    const sale = await makeSale(w);
    await request(server())
      .post(`/v1/pos/sales/${sale.id}/void`)
      .set('Authorization', bearer(w.deviceToken))
      .send({ reason: '   ' })
      .expect(422);
  });

  // ---------------------------------------------------------------- refund

  it('locks the PIN after 4 wrong attempts (invalid ×4 then locked)', async () => {
    const w = await seedWorld();
    const sale = await makeSale(w);
    const attempt = (pin: string) =>
      request(server())
        .post(`/v1/pos/sales/${sale.id}/refund`)
        .set('Authorization', bearer(w.deviceToken))
        .send({ reason: 'x', pin });

    const remaining: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await attempt('0000').expect(403);
      expect(r.body.code).toBe('pin_invalid');
      remaining.push(r.body.attemptsRemaining);
    }
    expect(remaining).toEqual([3, 2, 1, 0]);

    // 5th attempt (even with the CORRECT pin) is locked.
    const locked = await attempt(PIN).expect(423);
    expect(locked.body.code).toBe('pin_locked');

    // Sale is still completed (never refunded), stock never restored.
    const row = await raw.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.status).toBe('completed');
    expect(await stockQty(w.branchId, w.p1.id)).toBe('3');

    // PIN failures are audited with the attempted identity.
    const fails = await raw.auditLog.findMany({
      where: { action: 'auth.pin_failure' },
    });
    expect(fails.length).toBe(4);
    expect(fails[0].actorId).toBe(w.terminalId);
    expect(fails[0].actorType).toBe('terminal'); // consistent (type, id) pair
  });

  it('refunds with the correct PIN in-shift: attributes refund_shift_id and drops expected cash', async () => {
    const w = await seedWorld();
    const sale = await makeSale(w);

    const res = await request(server())
      .post(`/v1/pos/sales/${sale.id}/refund`)
      .set('Authorization', bearer(w.deviceToken))
      .send({ reason: 'customer changed mind', pin: PIN })
      .expect(200);
    expect(res.body.status).toBe('refunded');
    expect(res.body.statusReason).toBe('customer changed mind');
    expect(typeof res.body.refundedAt).toBe('string');
    expect(res.body.refundShiftId).toBe(w.shiftId);

    expect(await stockQty(w.branchId, w.p1.id)).toBe('5'); // restored
    const refundMoves = await raw.stockMovement.findMany({
      where: { refId: sale.id, type: 'refund' },
    });
    expect(refundMoves).toHaveLength(1);

    // Shift totals: sale still counts as sold, refund offsets cash (§8).
    const totals = await request(server())
      .get('/v1/pos/shifts/current/totals')
      .set('Authorization', bearer(w.deviceToken))
      .expect(200);
    expect(totals.body.refundCount).toBe(1);
    expect(totals.body.cashRefundsC).toBe(sale.totals.totalC);
    // expected = opening 200000 + cashSales(total) − cashRefunds(total) + 0 − 0
    expect(totals.body.expectedCashC).toBe(200000);
  });

  it('refund after the shift closed is out-of-shift (refund_shift_id null)', async () => {
    const w = await seedWorld();
    const sale = await makeSale(w);
    await request(server())
      .post('/v1/pos/shifts/current/close')
      .set('Authorization', bearer(w.deviceToken))
      .send({ countedCashC: 0 })
      .expect(200);
    // A brand-new shift is opened.
    await request(server())
      .post('/v1/pos/shifts')
      .set('Authorization', bearer(w.deviceToken))
      .send({ openingCashC: 100000 })
      .expect(201);

    const res = await request(server())
      .post(`/v1/pos/sales/${sale.id}/refund`)
      .set('Authorization', bearer(w.deviceToken))
      .send({ reason: 'late refund', pin: PIN })
      .expect(200);
    expect(res.body.status).toBe('refunded');
    expect(res.body.refundShiftId).toBeNull(); // out-of-shift

    // The new shift's expected cash is untouched by the out-of-shift refund.
    const totals = await request(server())
      .get('/v1/pos/shifts/current/totals')
      .set('Authorization', bearer(w.deviceToken))
      .expect(200);
    expect(totals.body.refundCount).toBe(0);
    expect(totals.body.cashRefundsC).toBe(0);
    expect(totals.body.expectedCashC).toBe(100000);
  });

  it('rejects refunding an already-voided sale (422), no status/stock change', async () => {
    const w = await seedWorld();
    const sale = await makeSale(w);
    await request(server())
      .post(`/v1/pos/sales/${sale.id}/void`)
      .set('Authorization', bearer(w.deviceToken))
      .send({ reason: 'void first' })
      .expect(200);
    expect(await stockQty(w.branchId, w.p1.id)).toBe('5');

    await request(server())
      .post(`/v1/pos/sales/${sale.id}/refund`)
      .set('Authorization', bearer(w.deviceToken))
      .send({ reason: 'nope', pin: PIN })
      .expect(422);

    const row = await raw.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.status).toBe('voided'); // unchanged
    expect(row.refundedAt).toBeNull();
    // No refund movement, no refund-status audit.
    expect(
      await raw.stockMovement.count({
        where: { refId: sale.id, type: 'refund' },
      }),
    ).toBe(0);
    expect(
      await raw.auditLog.count({
        where: { action: 'sale.update', entityId: sale.id },
      }),
    ).toBeLessThanOrEqual(1); // only the void's update, not a refund one
  });

  it('rejects unauthenticated void/refund (401)', async () => {
    await request(server())
      .post(`/v1/pos/sales/${randomUUID()}/void`)
      .send({ reason: 'x' })
      .expect(401);
    await request(server())
      .post(`/v1/pos/sales/${randomUUID()}/refund`)
      .send({ reason: 'x', pin: PIN })
      .expect(401);
  });
});
