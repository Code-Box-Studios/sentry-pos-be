/*
 * Task 21 — contract e2e. Walks the FE PosApi contract table asserting status
 * codes, `code` strings, and key response fields for each row, INCLUDING
 * Decimal-as-number serialization (taxRate 0.12, stock qty 23.45, sale item qty).
 * Also asserts the emitted OpenAPI document carries all 19 FE operationIds.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashSecret } from '../src/auth/hashing';
import { computeTotals } from '../src/common/totals/totals';
import type { Cart, CartLine } from '../src/common/totals/cart';
import { buildOpenApiDocument, POS_OPERATION_ID_VALUES } from '../src/openapi';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();
const PASSWORD = 'sentry-demo';
const PIN = '123456';
const TAX_RATE = 0.12;
const SC_RATE = 0.05;
let seq = 0;

describe('POS API contract (e2e)', () => {
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

  /** Seed owner+user(password/PIN)→business(0.12/0.05)→branch→catalog(+stock 23.45). */
  async function seedTenant() {
    seq += 1;
    const owner = await raw.owner.create({
      data: {
        name: `Maria ${seq}`,
        email: `owner-${seq}-${Date.now()}@test.com`,
        status: 'active',
        maxBusinesses: 5,
      },
    });
    const email = `maria-${seq}-${Date.now()}@test.com`;
    await raw.user.create({
      data: {
        email,
        role: 'owner',
        ownerId: owner.id,
        passwordHash: await hashSecret(PASSWORD),
        pinHash: await hashSecret(PIN),
      },
    });
    const business = await raw.business.create({
      data: {
        ownerId: owner.id,
        name: 'Kape Diaria',
        type: 'mixed',
        currency: 'PHP',
        taxRate: String(TAX_RATE),
        serviceChargeRate: String(SC_RATE),
      },
    });
    const branch = await raw.branch.create({
      data: {
        businessId: business.id,
        name: 'Marikit',
        code: 'MKT',
        address: 'Marikit St',
      },
    });
    const category = await raw.category.create({
      data: { businessId: business.id, name: 'Coffee', sortOrder: 1 },
    });
    const coffee = await raw.product.create({
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
      data: { branchId: branch.id, productId: coffee.id, qty: '5' },
    });
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
    return { owner, email, business, branch, coffee, rice };
  }

  function buildDraft(shiftId: string, coffeeId: string, qty: number) {
    const line: CartLine = {
      id: randomUUID(),
      productId: coffeeId,
      variantId: null,
      name: 'Espresso',
      soldBy: 'unit',
      qty,
      unitPriceC: 8500,
      modifiers: [],
      discount: null,
      scPwdMarked: false,
      trackStock: true,
    };
    const cart: Cart = {
      id: randomUUID(),
      orderType: 'takeout',
      lines: [line],
      orderDiscount: null,
      scPwd: null,
    };
    const totals = computeTotals(cart, {
      taxRate: TAX_RATE,
      serviceChargeRate: SC_RATE,
    });
    seq += 1;
    return {
      id: cart.id,
      receiptNo: `R-${seq}`,
      shiftId,
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
  }

  // -------------------------------------------------------------- operationIds

  it('the OpenAPI document exposes all 19 FE PosApi operationIds', () => {
    const doc = buildOpenApiDocument(app);
    const ids = new Set<string>();
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path)) {
        const id = (op as { operationId?: string })?.operationId;
        if (id) ids.add(id);
      }
    }
    for (const id of POS_OPERATION_ID_VALUES) {
      expect(ids.has(id)).toBe(true);
    }
    expect(POS_OPERATION_ID_VALUES).toHaveLength(19);

    // Presence + count is not enough: a swapped map key would still pass. Assert
    // the FE-critical operationIds sit on the RIGHT path + method so a mis-keying
    // in POS_OPERATION_IDS (which would scramble the generated client) fails here.
    const opId = (p: string, m: 'get' | 'post') =>
      (doc.paths[p] as Record<string, { operationId?: string }>)?.[m]
        ?.operationId;
    expect(opId('/v1/pos/pairing/sign-in', 'post')).toBe('ownerSignIn');
    expect(opId('/v1/pos/pairing/pair', 'post')).toBe('pairTerminal');
    expect(opId('/v1/health', 'get')).toBe('health');
    expect(opId('/v1/pos/catalog', 'get')).toBe('pullCatalog');
    expect(opId('/v1/pos/shifts/current', 'get')).toBe('getCurrentShift');
    expect(opId('/v1/pos/shifts', 'post')).toBe('openShift');
    expect(opId('/v1/pos/shifts/current/close', 'post')).toBe('closeShift');
    expect(opId('/v1/pos/sales', 'post')).toBe('completeSale');
    expect(opId('/v1/pos/sales', 'get')).toBe('listSales');
    expect(opId('/v1/pos/sales/{id}', 'get')).toBe('getSale');
    expect(opId('/v1/pos/sales/{id}/void', 'post')).toBe('voidSale');
    expect(opId('/v1/pos/sales/{id}/refund', 'post')).toBe('refundSale');
    expect(opId('/v1/pos/stock', 'get')).toBe('getStockLevels');
    expect(opId('/v1/pos/stock/adjustments', 'post')).toBe('adjustStock');
  });

  // ----------------------------------------------------------- pairing rows

  it('ownerSignIn / pairTerminal / unpair contract rows', async () => {
    const t = await seedTenant();

    // ownerSignIn — wrong password → 401 login_invalid.
    const bad = await request(server())
      .post('/v1/pos/pairing/sign-in')
      .send({ email: t.email, password: 'wrong' })
      .expect(401);
    expect(bad.body.code).toBe('login_invalid');

    // ownerSignIn — correct → 200 + pairing token.
    const signIn = await request(server())
      .post('/v1/pos/pairing/sign-in')
      .send({ email: t.email, password: PASSWORD })
      .expect(201);
    const pairingToken = signIn.body.token as string;
    expect(typeof pairingToken).toBe('string');

    // listBusinesses — bad token → 401.
    await request(server())
      .get('/v1/pos/pairing/businesses')
      .set('Authorization', bearer('garbage'))
      .expect(401);

    // listBusinesses / listBranches — with token.
    const biz = await request(server())
      .get('/v1/pos/pairing/businesses')
      .set('Authorization', bearer(pairingToken))
      .expect(200);
    expect(biz.body.some((b: any) => b.id === t.business.id)).toBe(true);
    await request(server())
      .get(`/v1/pos/pairing/businesses/${t.business.id}/branches`)
      .set('Authorization', bearer(pairingToken))
      .expect(200);

    // pairTerminal — returns receiptSeq + FE business settings (taxRate as number).
    const pair = await request(server())
      .post('/v1/pos/pairing/pair')
      .set('Authorization', bearer(pairingToken))
      .send({
        businessId: t.business.id,
        branchId: t.branch.id,
        terminalName: 'Register 1',
      })
      .expect(201);
    expect(typeof pair.body.receiptSeq).toBe('number');
    expect(pair.body.business.taxRate).toBe(0.12);
    const deviceToken = pair.body.deviceToken as string;

    // health.
    const health = await request(server()).get('/v1/health').expect(200);
    expect(health.body).toEqual({ ok: true });

    // unpair — wrong re-auth → 401.
    await request(server())
      .post('/v1/pos/unpair')
      .set('Authorization', bearer(deviceToken))
      .send({ email: t.email, password: 'wrong' })
      .expect(401);
  });

  // ------------------------------------------------- device-token contract rows

  it('catalog / shift / sale / stock rows with Decimal-as-number', async () => {
    const t = await seedTenant();
    const signIn = await request(server())
      .post('/v1/pos/pairing/sign-in')
      .send({ email: t.email, password: PASSWORD })
      .expect(201);
    const pair = await request(server())
      .post('/v1/pos/pairing/pair')
      .set('Authorization', bearer(signIn.body.token))
      .send({
        businessId: t.business.id,
        branchId: t.branch.id,
        terminalName: 'Register 1',
      })
      .expect(201);
    const device = pair.body.deviceToken as string;
    const auth = { Authorization: bearer(device) };

    // pullCatalog — Decimal taxRate as a number.
    const catalog = await request(server())
      .get('/v1/pos/catalog')
      .set(auth)
      .expect(200);
    expect(catalog.body.business.taxRate).toBe(0.12);

    // getStockLevels — Decimal qty as a number.
    const stock = await request(server())
      .get('/v1/pos/stock')
      .set(auth)
      .expect(200);
    const riceLevel = stock.body.find((s: any) => s.productId === t.rice.id);
    expect(riceLevel.qty).toBe(23.45);
    expect(typeof riceLevel.qty).toBe('number');

    // adjustStock — negative target → 422 validation.
    const negAdjust = await request(server())
      .post('/v1/pos/stock/adjustments')
      .set(auth)
      .send({ productId: t.rice.id, newQty: -1, reasonCategory: 'damage' })
      .expect(422);
    expect(negAdjust.body.code).toBe('validation');

    // getShiftTotals — no open shift → 422.
    await request(server())
      .get('/v1/pos/shifts/current/totals')
      .set(auth)
      .expect(422);

    // openShift → then double-open → 422.
    const shift = await request(server())
      .post('/v1/pos/shifts')
      .set(auth)
      .send({ openingCashC: 200000 })
      .expect(201);
    await request(server())
      .post('/v1/pos/shifts')
      .set(auth)
      .send({ openingCashC: 1 })
      .expect(422);

    // completeSale — idempotent by id, 409 stock_conflict, 422 totals.
    const draft = buildDraft(shift.body.id, t.coffee.id, 2);
    await request(server())
      .post('/v1/pos/sales')
      .set(auth)
      .send(draft)
      .expect(201);
    await request(server())
      .post('/v1/pos/sales')
      .set(auth)
      .send(draft)
      .expect(200); // replay

    const short = buildDraft(shift.body.id, t.coffee.id, 999);
    const conflict = await request(server())
      .post('/v1/pos/sales')
      .set(auth)
      .send(short)
      .expect(409);
    expect(conflict.body.code).toBe('stock_conflict');
    expect(Array.isArray(conflict.body.conflicts)).toBe(true);

    const tampered = buildDraft(shift.body.id, t.coffee.id, 1);
    (tampered.totals as { totalC: number }).totalC = 1;
    const badTotals = await request(server())
      .post('/v1/pos/sales')
      .set(auth)
      .send(tampered)
      .expect(422);
    expect(badTotals.body.code).toBe('validation');

    // getSale echoes the stored draft snapshot (§5.1), so lines[].qty is the
    // client-supplied number round-tripping through storage — a contract check,
    // NOT a Decimal-serialization test (no sales endpoint serializes a persisted
    // Decimal column). The genuine Decimal-as-number coverage is the taxRate
    // (business Decimal) and stock qty 23.45 (branch_stock Decimal) assertions
    // above, both of which fail if `.toNumber()` were dropped.
    const got = await request(server())
      .get(`/v1/pos/sales/${draft.id}`)
      .set(auth)
      .expect(200);
    expect(got.body.lines[0].qty).toBe(2);
    expect(typeof got.body.lines[0].qty).toBe('number');

    // listSales.
    const list = await request(server())
      .get('/v1/pos/sales')
      .set(auth)
      .expect(200);
    expect(list.body.some((s: any) => s.id === draft.id)).toBe(true);

    // refundSale — wrong PIN → 403 pin_invalid {attemptsRemaining}.
    const refund = await request(server())
      .post(`/v1/pos/sales/${draft.id}/refund`)
      .set(auth)
      .send({ reason: 'x', pin: '0000' })
      .expect(403);
    expect(refund.body.code).toBe('pin_invalid');
    expect(typeof refund.body.attemptsRemaining).toBe('number');

    // addCashMovement / closeShift, then no-shift 422 rows.
    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set(auth)
      .send({ type: 'in', amountC: 100, reason: 'float' })
      .expect(201);
    await request(server())
      .post('/v1/pos/shifts/current/close')
      .set(auth)
      .send({ countedCashC: 0 })
      .expect(200);
    await request(server())
      .post('/v1/pos/shifts/current/cash-movements')
      .set(auth)
      .send({ type: 'in', amountC: 100, reason: 'x' })
      .expect(422);
  });
});
