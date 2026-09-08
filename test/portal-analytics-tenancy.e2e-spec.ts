/*
 * Analytics is the only place in this API that runs raw SQL, and raw SQL
 * bypasses the tenancy choke point entirely (`scoped-sql.ts` explains why).
 * These are the tests that keep that honest: every endpoint, both directions.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { resetDb, closeDb } from './helpers/db';
import { seedSale } from './helpers/sales';

const raw = new PrismaClient();

const DURING = new Date('2026-03-02T02:00:00.000Z');
const RANGE = { from: '2026-03-01', to: '2026-03-07' };

/** Every report endpoint, so a new one cannot be added without a decision. */
const ENDPOINTS = [
  'analytics/overview',
  'analytics/sales/heatmap',
  'analytics/sales/trend',
  'analytics/sales/patterns',
  'analytics/sales/breakdowns',
  'analytics/tax',
  'analytics/products/top',
  'analytics/products/slow',
  'analytics/profit',
  'analytics/leaks',
  'analytics/inventory/movements',
  'analytics/inventory/shrinkage',
  'analytics/inventory/on-hand',
];

// `analytics/products/:productId/trend` is deliberately absent: it needs a
// product id, so its ownership case lives in the products spec, where a foreign
// product id asserts 404.

describe('Portal analytics — tenancy (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  const server = () => app.getHttpServer();

  async function seedTenant() {
    const owner = await raw.owner.create({
      data: {
        name: 'O',
        email: `o-${Date.now()}-${Math.random()}@t.com`,
        status: 'active',
        maxBusinesses: 5,
      },
    });
    const user = await raw.user.create({
      data: {
        email: `u-${Date.now()}-${Math.random()}@t.com`,
        role: 'owner',
        ownerId: owner.id,
        passwordHash: 'x',
      },
    });
    const business = await raw.business.create({
      data: { ownerId: owner.id, name: 'B', type: 'retail', taxRate: '0.12' },
    });
    const branch = await raw.branch.create({
      data: { businessId: business.id, name: 'Main', code: 'MN', address: 'x' },
    });
    const terminal = await raw.terminal.create({
      data: { branchId: branch.id, name: 'T1', code: 'T1' },
    });
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    return {
      token: accessToken,
      ownerId: owner.id,
      businessId: business.id,
      branchId: branch.id,
      terminalId: terminal.id,
    };
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

  it('404s on every endpoint when the businessId belongs to someone else', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    for (const path of ENDPOINTS) {
      await request(server())
        .get(`/v1/portal/${path}`)
        .query({ ...RANGE, businessId: theirs.businessId })
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(404);
    }
  });

  it('404s on every endpoint when the branchId belongs to someone else', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    for (const path of ENDPOINTS) {
      await request(server())
        .get(`/v1/portal/${path}`)
        .query({
          ...RANGE,
          businessId: mine.businessId,
          branchId: theirs.branchId,
        })
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(404);
    }
  });

  it("never counts another owner's sales in an unscoped sweep", async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    await seedSale(raw, {
      branchId: mine.branchId,
      terminalId: mine.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: theirs.branchId,
      terminalId: theirs.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 99900 }],
    });

    const overview = await request(server())
      .get('/v1/portal/analytics/overview')
      .query(RANGE)
      .set('Authorization', `Bearer ${mine.token}`)
      .expect(200);
    expect(overview.body.grossSalesC.value).toBe(10000);

    const breakdowns = await request(server())
      .get('/v1/portal/analytics/sales/breakdowns')
      .query(RANGE)
      .set('Authorization', `Bearer ${mine.token}`)
      .expect(200);
    expect(breakdowns.body.byBranch.map((b: any) => b.branchId)).toEqual([
      mine.branchId,
    ]);

    const dashboard = await request(server())
      .get('/v1/portal/dashboard')
      .set('Authorization', `Bearer ${mine.token}`)
      .expect(200);
    expect(dashboard.body.businesses.map((b: any) => b.businessId)).toEqual([
      mine.businessId,
    ]);
  });

  it('rejects an unauthenticated caller on every endpoint, dashboard included', async () => {
    for (const path of [...ENDPOINTS, 'dashboard']) {
      await request(server())
        .get(`/v1/portal/${path}`)
        .query(RANGE)
        .expect(401);
    }
  });
});
