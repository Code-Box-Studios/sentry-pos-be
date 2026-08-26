/*
 * Task 19 — POS completeSale e2e (TDD-heavy: the sale transaction).
 *
 * A paired terminal posts an FE SaleDraft; the server recomputes totals, checks
 * stock atomically, and persists an idempotent, byte-identical CompletedSale.
 * Valid drafts are built with the REAL BE totals engine so a legitimate draft
 * always matches the server recompute.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
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
import { computeTotals } from '../src/common/totals/totals';
import type { Cart, CartLine } from '../src/common/totals/cart';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

const TAX_RATE = 0.12;
const SC_RATE = 0.05;

let seq = 0;

/** Manila (UTC+8) day key for "now", e.g. 2026-08-26. */
function manilaToday(): string {
  const now = new Date();
  const manila = new Date(now.getTime() + 8 * 3600 * 1000);
  return manila.toISOString().slice(0, 10);
}

describe('POS completeSale (e2e)', () => {
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

  /**
   * Seed owner→business→branch→terminal→open shift, plus two stocked products:
   * P1 (unit, qty 5) and P2 with variant V (qty 3), and weight product P3 (qty 2).
   */
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

    // P1: plain unit product, cost 3000, price 8500, stock 5.
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

    // P2: product with one variant V (price 14000), stock 3 on the variant.
    const p2 = await raw.product.create({
      data: {
        businessId: business.id,
        categoryId: category.id,
        name: 'Latte',
        price: 12000,
        trackStock: true,
        variants: { create: { name: 'Large', price: 14000, cost: 6000 } },
      },
      include: { variants: true },
    });
    const v = p2.variants[0];
    await raw.branchStock.create({
      data: {
        branchId: branch.id,
        productId: p2.id,
        variantId: v.id,
        qty: '3',
      },
    });

    // P3: weight product, price per kg 20000, stock 2.000.
    const p3 = await raw.product.create({
      data: {
        businessId: business.id,
        categoryId: category.id,
        name: 'Beans',
        price: 20000,
        soldBy: 'weight',
        trackStock: true,
      },
    });
    await raw.branchStock.create({
      data: { branchId: branch.id, productId: p3.id, qty: '2' },
    });

    // A real named discount owned by this business (10% off).
    const discount = await raw.discount.create({
      data: {
        businessId: business.id,
        name: 'Merienda',
        kind: 'percent',
        value: 10,
        appliesTo: 'both',
      },
    });

    return {
      deviceToken,
      branchId: branch.id,
      terminalId: terminal.id,
      businessId: business.id,
      shiftId: shift.id,
      p1,
      p2,
      v,
      p3,
      discount,
    };
  }

  function line(partial: Partial<CartLine> & { id: string }): CartLine {
    return {
      productId: null,
      variantId: null,
      name: 'Item',
      soldBy: 'unit',
      qty: 1,
      unitPriceC: 0,
      modifiers: [],
      discount: null,
      scPwdMarked: false,
      trackStock: false,
      ...partial,
    };
  }

  /** Build a valid SaleDraft: totals via the real engine, cash payment = total. */
  function buildDraft(opts: {
    shiftId: string;
    lines: CartLine[];
    orderType?: Cart['orderType'];
    receiptNo?: string;
    tenderedC?: number;
  }) {
    const cart: Cart = {
      id: randomUUID(),
      orderType: opts.orderType ?? 'takeout',
      lines: opts.lines,
      orderDiscount: null,
      scPwd: null,
    };
    const totals = computeTotals(cart, {
      taxRate: TAX_RATE,
      serviceChargeRate: SC_RATE,
    });
    const tenderedC = opts.tenderedC ?? totals.totalC;
    return {
      id: cart.id,
      receiptNo: opts.receiptNo ?? `R-${seq}-${Math.floor(totals.totalC)}`,
      shiftId: opts.shiftId,
      orderType: cart.orderType,
      lines: opts.lines,
      orderDiscount: null,
      scPwd: null,
      totals,
      payment: {
        id: randomUUID(),
        method: 'cash',
        referenceNo: null,
        amountC: totals.totalC,
        tenderedC,
        changeC: tenderedC - totals.totalC,
      },
      createdAtDevice: new Date().toISOString(),
    };
  }

  const postSale = (token: string, draft: unknown) =>
    request(server())
      .post('/v1/pos/sales')
      .set('Authorization', bearer(token))
      .send(draft as object);

  it('rejects unauthenticated access (401)', async () => {
    await request(server()).post('/v1/pos/sales').send({}).expect(401);
    await request(server()).get('/v1/pos/sales').expect(401);
  });

  it('completes a sale: persists sale/items/payment/movements/draft and decrements stock', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'R-001',
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 2,
          unitPriceC: 8500,
          trackStock: true,
        }),
      ],
    });

    const res = await postSale(w.deviceToken, draft).expect(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.statusReason).toBeNull();
    expect(res.body.id).toBe(draft.id);
    expect(res.body.receiptNo).toBe('R-001');
    expect(res.body.totals.totalC).toBe(draft.totals.totalC);
    expect(res.body.payment.id).toBe(draft.payment.id);
    expect(typeof res.body.createdAt).toBe('string');
    expect(res.body.refundShiftId).toBeNull();

    // Persisted rows.
    const saleRow = await raw.sale.findUniqueOrThrow({
      where: { id: draft.id },
      include: { items: true, payments: true },
    });
    expect(saleRow.status).toBe('completed');
    expect(saleRow.total).toBe(draft.totals.totalC);
    expect(saleRow.subtotal).toBe(17000);
    expect(saleRow.items).toHaveLength(1);
    expect(saleRow.items[0].costSnapshot).toBe(3000); // current product cost
    expect(saleRow.items[0].nameSnapshot).toBe('Espresso');
    expect(saleRow.payments).toHaveLength(1);
    expect(saleRow.syncedAt).not.toBeNull();

    // Stock decremented 5 → 3.
    const level = await raw.branchStock.findFirstOrThrow({
      where: { branchId: w.branchId, productId: w.p1.id, variantId: null },
    });
    expect(level.qty.toString()).toBe('3');

    // One sale movement, negative delta, ref = sale id.
    const movements = await raw.stockMovement.findMany({
      where: { refId: draft.id, type: 'sale' },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].qtyDelta.toString()).toBe('-2');

    // receipt_seq bumped past 1.
    const term = await raw.terminal.findUniqueOrThrow({
      where: { id: w.terminalId },
    });
    expect(term.receiptSeq).toBe(2);
  });

  it('is idempotent: same draft twice → one sale, second response deep-equals the first (200)', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'R-IDEM',
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
        }),
      ],
    });

    const first = await postSale(w.deviceToken, draft).expect(201);
    const second = await postSale(w.deviceToken, draft).expect(200);
    expect(second.body).toEqual(first.body);

    // Exactly one sale, stock only decremented once (5 → 4).
    const count = await raw.sale.count({ where: { id: draft.id } });
    expect(count).toBe(1);
    const level = await raw.branchStock.findFirstOrThrow({
      where: { branchId: w.branchId, productId: w.p1.id, variantId: null },
    });
    expect(level.qty.toString()).toBe('4');

    // GET /:id returns the identical CompletedSale.
    const got = await request(server())
      .get(`/v1/pos/sales/${draft.id}`)
      .set('Authorization', bearer(w.deviceToken))
      .expect(200);
    expect(got.body).toEqual(first.body);
  });

  it('rejects a tampered total (422) and writes nothing', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
        }),
      ],
    });
    (draft.totals as { totalC: number }).totalC = 1; // tamper

    await postSale(w.deviceToken, draft).expect(422);
    expect(await raw.sale.count({ where: { id: draft.id } })).toBe(0);
    const level = await raw.branchStock.findFirstOrThrow({
      where: { branchId: w.branchId, productId: w.p1.id, variantId: null },
    });
    expect(level.qty.toString()).toBe('5'); // unchanged
  });

  it('rejects a payment amount that does not match the total (422)', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
        }),
      ],
    });
    draft.payment.amountC = draft.totals.totalC + 1; // wrong

    await postSale(w.deviceToken, draft).expect(422);
  });

  it('rejects when the shift is not the open shift (422)', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: randomUUID(), // not the open shift
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
        }),
      ],
    });
    await postSale(w.deviceToken, draft).expect(422);
  });

  it('returns 409 stock_conflict with every failing line and writes nothing', async () => {
    const w = await seedWorld();
    // Want 6 of P1 (stock 5) and 5 of variant V (stock 3): both conflict.
    const draft = buildDraft({
      shiftId: w.shiftId,
      lines: [
        line({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          productId: w.p1.id,
          name: 'Espresso',
          qty: 6,
          unitPriceC: 8500,
          trackStock: true,
        }),
        line({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          productId: w.p2.id,
          variantId: w.v.id,
          name: 'Latte — Large',
          qty: 5,
          unitPriceC: 14000,
          trackStock: true,
        }),
      ],
    });

    const res = await postSale(w.deviceToken, draft).expect(409);
    expect(res.body.code).toBe('stock_conflict');
    const conflicts = res.body.conflicts;
    expect(conflicts).toHaveLength(2);
    const byProduct = new Map<string, any>(
      conflicts.map((c: any) => [c.productId, c]),
    );
    expect(byProduct.get(w.p1.id).availableQty).toBe(5);
    expect(byProduct.get(w.p2.id).availableQty).toBe(3);
    expect(byProduct.get(w.p1.id).lineId).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    // No writes.
    expect(await raw.sale.count({ where: { id: draft.id } })).toBe(0);
    const l1 = await raw.branchStock.findFirstOrThrow({
      where: { branchId: w.branchId, productId: w.p1.id, variantId: null },
    });
    expect(l1.qty.toString()).toBe('5');
    const l2 = await raw.branchStock.findFirstOrThrow({
      where: { branchId: w.branchId, productId: w.p2.id, variantId: w.v.id },
    });
    expect(l2.qty.toString()).toBe('3');
  });

  it('rolls back everything (incl. stock) when the receipt number collides after decrement', async () => {
    const w = await seedWorld();
    // Pre-existing sale with the SAME receiptNo on this terminal, different id.
    await raw.sale.create({
      data: {
        branchId: w.branchId,
        terminalId: w.terminalId,
        shiftId: w.shiftId,
        receiptNo: 'DUP-1',
        orderType: 'takeout',
        status: 'completed',
        subtotal: 100,
        tax: 0,
        total: 100,
        createdAtDevice: new Date(),
        draft: {},
      },
    });

    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'DUP-1', // collides
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 2,
          unitPriceC: 8500,
          trackStock: true,
        }),
      ],
    });

    await postSale(w.deviceToken, draft).expect(422);

    // The new sale never landed; stock is untouched (rollback restored the decrement).
    expect(await raw.sale.count({ where: { id: draft.id } })).toBe(0);
    const level = await raw.branchStock.findFirstOrThrow({
      where: { branchId: w.branchId, productId: w.p1.id, variantId: null },
    });
    expect(level.qty.toString()).toBe('5');
  });

  it('decrements a weight line by exactly 0.750', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'R-WT',
      lines: [
        line({
          id: randomUUID(),
          productId: w.p3.id,
          name: 'Beans',
          soldBy: 'weight',
          qty: 0.75,
          unitPriceC: 20000,
          trackStock: true,
        }),
      ],
    });
    await postSale(w.deviceToken, draft).expect(201);

    const level = await raw.branchStock.findFirstOrThrow({
      where: { branchId: w.branchId, productId: w.p3.id, variantId: null },
    });
    expect(level.qty.toString()).toBe('1.25'); // 2.000 − 0.750
    const mv = await raw.stockMovement.findFirstOrThrow({
      where: { refId: draft.id, type: 'sale' },
    });
    expect(mv.qtyDelta.toString()).toBe('-0.75');
  });

  it('bumps receipt_seq from the trailing digit run of the receipt number', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'DEMO-MKT-T1-000001',
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
        }),
      ],
    });
    await postSale(w.deviceToken, draft).expect(201);
    const term = await raw.terminal.findUniqueOrThrow({
      where: { id: w.terminalId },
    });
    expect(term.receiptSeq).toBe(2); // seq("...000001") + 1
  });

  it('lists sales for the Manila day and reads one back', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'R-LIST',
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
        }),
      ],
    });
    await postSale(w.deviceToken, draft).expect(201);

    const list = await request(server())
      .get(`/v1/pos/sales?date=${manilaToday()}`)
      .set('Authorization', bearer(w.deviceToken))
      .expect(200);
    const summary = list.body.find((s: any) => s.id === draft.id);
    expect(summary).toBeTruthy();
    expect(summary.receiptNo).toBe('R-LIST');
    expect(summary.lineCount).toBe(1);
    expect(summary.method).toBe('cash');
    expect(summary.status).toBe('completed');
    expect(summary.totalC).toBe(draft.totals.totalC);
    expect(summary.scPwd).toBe(false);

    // A far-past date returns nothing for this sale.
    const empty = await request(server())
      .get('/v1/pos/sales?date=2000-01-01')
      .set('Authorization', bearer(w.deviceToken))
      .expect(200);
    expect(empty.body.find((s: any) => s.id === draft.id)).toBeUndefined();
  });

  it('accepts a valid owned named line discount and records discount_id', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'R-DISC',
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
          discount: {
            source: 'named',
            discountId: w.discount.id,
            name: 'Merienda',
            kind: 'percent',
            value: 10,
          },
        }),
      ],
    });
    await postSale(w.deviceToken, draft).expect(201);

    const item = await raw.saleItem.findFirstOrThrow({
      where: { saleId: draft.id },
    });
    expect(item.discountId).toBe(w.discount.id);
    expect(item.discount).toBe(850); // 10% of 8500
  });

  it('rejects a named line discount whose id is unknown to this business (422)', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'R-FDISC',
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
          discount: {
            source: 'named',
            discountId: randomUUID(), // not a discount of this business
            name: 'Ghost',
            kind: 'percent',
            value: 10,
          },
        }),
      ],
    });
    await postSale(w.deviceToken, draft).expect(422);
    expect(await raw.sale.count({ where: { id: draft.id } })).toBe(0);
  });

  it('rejects a named discount with a malformed id (422, not 500)', async () => {
    const w = await seedWorld();
    const draft = buildDraft({
      shiftId: w.shiftId,
      receiptNo: 'R-BADID',
      lines: [
        line({
          id: randomUUID(),
          productId: w.p1.id,
          name: 'Espresso',
          qty: 1,
          unitPriceC: 8500,
          trackStock: true,
          discount: {
            source: 'named',
            discountId: 'not-a-uuid',
            name: 'Bad',
            kind: 'percent',
            value: 10,
          },
        }),
      ],
    });
    await postSale(w.deviceToken, draft).expect(422);
  });
});
