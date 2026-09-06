/*
 * Dashboard (analytics-spec §0) e2e — the portal landing.
 *
 * Uses the real clock rather than a fixed date, because the endpoint's whole
 * job is answering "today" against each business's own day start.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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

describe('Portal analytics — dashboard (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  const server = () => app.getHttpServer();

  async function seedTenant(over: Record<string, unknown> = {}) {
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
      data: {
        ownerId: owner.id,
        name: 'B',
        type: 'retail',
        taxRate: '0.12',
        ...over,
      },
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

  const dashboard = (token: string) =>
    request(server())
      .get('/v1/portal/dashboard')
      .set('Authorization', `Bearer ${token}`);

  /** Now, and the same clock time seven days ago. */
  const now = () => new Date();
  const lastWeek = () => new Date(Date.now() - 7 * 86_400_000);

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

  it('reports today per business, with a branch row and a 7-day sparkline', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: now(),
      lines: [{ qty: 1, unitPriceC: 10000, costC: 6000 }],
    });

    const res = await dashboard(t.token).expect(200);
    const business = res.body.businesses.find(
      (b: any) => b.businessId === t.businessId,
    );

    expect(business.today).toEqual({
      salesC: 10000,
      grossProfitC: 4000,
      transactions: 1,
    });
    expect(business.branches).toEqual([
      {
        branchId: t.branchId,
        name: 'Main',
        salesC: 10000,
        grossProfitC: 4000,
        transactions: 1,
      },
    ]);
    expect(business.sparkline).toHaveLength(7);
    expect(business.sparkline[6].salesC).toBe(10000);
  });

  it('compares against the same day last week', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: lastWeek(),
      lines: [{ qty: 1, unitPriceC: 5000 }],
    });

    const res = await dashboard(t.token).expect(200);
    const business = res.body.businesses.find(
      (b: any) => b.businessId === t.businessId,
    );

    expect(business.today.salesC).toBe(0);
    expect(business.sameDayLastWeek.salesC).toBe(5000);
  });

  it('excludes demo businesses from the landing', async () => {
    const t = await seedTenant();
    const demo = await raw.business.create({
      data: {
        ownerId: t.ownerId,
        name: 'Demo',
        type: 'retail',
        taxRate: '0.12',
        isDemo: true,
      },
    });
    await raw.branch.create({
      data: { businessId: demo.id, name: 'D', code: 'DM', address: 'x' },
    });

    const res = await dashboard(t.token).expect(200);
    expect(res.body.businesses.map((b: any) => b.businessId)).not.toContain(
      demo.id,
    );
  });

  it('lists open shifts and terminals in the live strip', async () => {
    const t = await seedTenant();
    await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date(),
        openingCash: 100000,
      },
    });

    const res = await dashboard(t.token).expect(200);

    expect(res.body.live.openShifts).toHaveLength(1);
    expect(res.body.live.openShifts[0]).toMatchObject({
      branchId: t.branchId,
      branchName: 'Main',
      terminalName: 'T1',
    });
    expect(res.body.live.terminals[0]).toMatchObject({
      code: 'T1',
      paired: false,
    });
  });

  it('counts unread notifications, which is zero until they are written', async () => {
    const t = await seedTenant();
    const res = await dashboard(t.token).expect(200);
    expect(res.body.live.unreadNotifications).toBe(0);
  });

  it('flags low stock and shifts left open past 24 hours', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Grocery' },
    });
    const product = await raw.product.create({
      data: {
        businessId: t.businessId,
        categoryId: category.id,
        name: 'Rice',
        price: 5000,
        lowStockThreshold: '10',
      },
    });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '4' },
    });
    await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date(Date.now() - 30 * 3_600_000),
        openingCash: 0,
      },
    });

    const res = await dashboard(t.token).expect(200);

    expect(res.body.attention.lowStock).toEqual([
      { businessId: t.businessId, count: 1 },
    ]);
    expect(res.body.attention.unclosedShifts).toEqual([
      { businessId: t.businessId, count: 1 },
    ]);
  });

  it('audits the dashboard read against each business', async () => {
    const t = await seedTenant();
    await dashboard(t.token).expect(200);

    const rows = await raw.auditLog.findMany({
      where: { businessId: t.businessId, action: 'audit.report_read' },
    });
    expect(rows).toHaveLength(1);
  });
});
