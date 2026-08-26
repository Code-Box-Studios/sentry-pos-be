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
    return { deviceToken, branchId: branch.id, rice };
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
  });

  it('rejects a negative adjustment target (422)', async () => {
    const w = await seedWorld();
    await request(server())
      .post('/v1/pos/stock/adjustments')
      .set('Authorization', bearer(w.deviceToken))
      .send({
        productId: w.rice.id,
        newQty: -1,
        reasonCategory: 'damage',
      })
      .expect(422);
  });
});
