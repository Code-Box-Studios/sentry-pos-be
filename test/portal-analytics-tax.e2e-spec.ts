/*
 * Tax summary (analytics-spec §6) e2e. The numbers must reconcile with a printed
 * receipt to the centavo, so they are asserted against the engine's own totals.
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

/** 2 March 2026, 10:00 Manila. */
const DURING = new Date('2026-03-02T02:00:00.000Z');

describe('Portal analytics — tax (e2e)', () => {
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

  const tax = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/tax')
      .query({ from: '2026-03-01', to: '2026-03-07', ...query })
      .set('Authorization', `Bearer ${token}`);

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

  it('reconciles vatable sales, VAT and the total to the centavo', async () => {
    const t = await seedTenant();
    const sale = await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      taxRate: 0.12,
      lines: [{ qty: 1, unitPriceC: 11200 }],
    });

    const res = await tax(t.token).expect(200);
    const row = res.body.businesses[0];

    // Prices are VAT-inclusive: 112.00 total carries 12.00 VAT over 100.00 net.
    expect(row.vatC).toBe(1200);
    expect(row.vatableSalesC).toBe(10000);
    expect(row.vatExemptSalesC).toBe(0);
    expect(row.vatableSalesC + row.vatC + row.vatExemptSalesC).toBe(sale.total);
  });

  it('reports SC/PWD sales as VAT-exempt with their discount', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      taxRate: 0.12,
      scPwd: { idNo: 'SC-1', name: 'Lola' },
      lines: [{ qty: 1, unitPriceC: 11200, scPwdMarked: true }],
    });

    const res = await tax(t.token).expect(200);
    const row = res.body.businesses[0];

    expect(row.vatExemptSalesC).toBeGreaterThan(0);
    expect(row.scPwdDiscountC).toBeGreaterThan(0);
    expect(row.vatC).toBe(0);
  });

  it('reports the service charge collected', async () => {
    const t = await seedTenant({ serviceChargeRate: '0.10' });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      orderType: 'dine_in',
      serviceChargeRate: 0.1,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await tax(t.token).expect(200);
    expect(res.body.businesses[0].serviceChargeC).toBe(1000);
  });

  it('keeps a row per business and never blends tax rates', async () => {
    const t = await seedTenant();
    const second = await raw.business.create({
      data: {
        ownerId: t.ownerId,
        name: 'Second',
        type: 'fnb',
        taxRate: '0.00',
      },
    });
    await raw.branch.create({
      data: { businessId: second.id, name: 'B2', code: 'B2', address: 'x' },
    });

    const res = await tax(t.token).expect(200);

    expect(res.body.businesses).toHaveLength(2);
    expect(res.body.businesses.map((b: any) => b.taxRate).sort()).toEqual([
      0, 0.12,
    ]);
    expect(res.body.totals).toBeDefined();
    expect(res.body.totals.taxRate).toBeUndefined();
  });

  it('exports as CSV in pesos', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 11200 }],
    });

    const res = await tax(t.token, { format: 'csv' }).expect(200);
    expect(res.headers['content-disposition']).toContain(
      'filename="tax-2026-03-01-2026-03-07.csv"',
    );
    expect(res.text).toContain('12.00');
  });
});
