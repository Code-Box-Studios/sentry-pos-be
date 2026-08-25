/*
 * Task 14 — Portal settings (refund PIN), audited activity-log reads, and
 * terminals (list + remote unpair) e2e (TDD).
 *
 * Owner-role token (tenant scope via PortalAuthGuard). Exercises: refund-PIN set
 * (argon2 into the platform users table + explicit audit), the tenant-scoped
 * activity-log read (business rows + the owner's own auth events, platform rows
 * excluded, the read itself audited), and terminal list + remote unpair.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { verifySecret } from '../src/auth/hashing';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();

let seq = 0;

async function seedOwner() {
  seq += 1;
  const owner = await raw.owner.create({
    data: {
      name: `Owner ${seq}`,
      email: `owner-${seq}-${Date.now()}@test.com`,
      status: 'active',
      maxBusinesses: 5,
    },
  });
  const user = await raw.user.create({
    data: {
      email: `user-${seq}-${Date.now()}@test.com`,
      role: 'owner',
      ownerId: owner.id,
      passwordHash: 'x',
    },
  });
  return { owner, user };
}

describe('Portal settings, activity-log, terminals (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  async function ownerToken() {
    const { owner, user } = await seedOwner();
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    return { owner, user, token: accessToken };
  }

  /** Owner + token + a business + a branch + a product. */
  async function ctx() {
    const { owner, user, token } = await ownerToken();
    const biz = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Biz', type: 'retail', currency: 'PHP', taxRate: 0.12 })
      .expect(201);
    const businessId = biz.body.id;
    const branch = await request(server())
      .post(`/v1/portal/businesses/${businessId}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main', code: 'MN', address: 'x' })
      .expect(201);
    const cat = await request(server())
      .post(`/v1/portal/businesses/${businessId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Coffee' })
      .expect(201);
    const prod = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ categoryId: cat.body.id, name: 'Latte', priceC: 12000 })
      .expect(201);
    return {
      owner,
      user,
      token,
      businessId,
      branchId: branch.body.id,
      productId: prod.body.id,
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

  const server = () => app.getHttpServer();

  // =========================================================================
  // Refund PIN
  // =========================================================================

  it('sets the refund PIN (argon2) and writes an audit row with no value', async () => {
    const { user, owner, token } = await ctx();

    await request(server())
      .put('/v1/portal/refund-pin')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '135790' })
      .expect(200);

    const row = await raw.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.pinHash).not.toBeNull();
    expect(await verifySecret(row.pinHash!, '135790')).toBe(true);

    const audit = await raw.auditLog.findMany({
      where: { action: 'user.refund_pin_set', entityId: user.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].actorType).toBe('owner');
    expect(audit[0].ownerId).toBe(owner.id);
    // The PIN value must never be logged.
    expect(JSON.stringify(audit[0])).not.toContain('135790');
  });

  it('rejects a PIN that is not exactly 6 digits (422)', async () => {
    const { token } = await ctx();
    for (const pin of ['12345', '1234567', 'abcdef', '12 345']) {
      await request(server())
        .put('/v1/portal/refund-pin')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin })
        .expect(422);
    }
  });

  // =========================================================================
  // Terminals
  // =========================================================================

  it('lists terminals (paired flag, no token hash) and remote-unpairs one', async () => {
    const { token, branchId } = await ctx();
    const terminal = await raw.terminal.create({
      data: {
        branchId,
        name: 'Register 1',
        code: 'REG1',
        deviceTokenHash: 'secret-hash',
      },
    });

    const list = await request(server())
      .get(`/v1/portal/businesses/${await businessOf(branchId)}/terminals`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const t = list.body.find((x: any) => x.id === terminal.id);
    expect(t).toBeDefined();
    expect(t.paired).toBe(true);
    expect(t.code).toBe('REG1');
    expect(t.pairedAt).toBeDefined();
    expect(t.deviceTokenHash).toBeUndefined(); // never exposed

    const un = await request(server())
      .post(`/v1/portal/terminals/${terminal.id}/unpair`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(un.body.paired).toBe(false);

    const row = await raw.terminal.findUniqueOrThrow({
      where: { id: terminal.id },
    });
    expect(row.deviceTokenHash).toBeNull();
  });

  it('does not let an owner list/unpair another owner’s terminals', async () => {
    const a = await ctx();
    const b = await ctx();
    const terminal = await raw.terminal.create({
      data: {
        branchId: a.branchId,
        name: 'T',
        code: 'T1',
        deviceTokenHash: 'h',
      },
    });

    await request(server())
      .get(`/v1/portal/businesses/${a.businessId}/terminals`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
    await request(server())
      .post(`/v1/portal/terminals/${terminal.id}/unpair`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
  });

  // =========================================================================
  // Activity log
  // =========================================================================

  it('returns tenant rows + owner auth events, excludes platform rows, and self-audits', async () => {
    const { token, businessId, productId, owner, user } = await ctx();

    // A genuine business mutation the BO should see.
    await request(server())
      .patch(`/v1/portal/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed Latte' })
      .expect(200);

    // The owner's own login auth event (businessId null, ownerId set).
    await raw.auditLog.create({
      data: {
        actorType: 'owner',
        actorId: user.id,
        ownerId: owner.id,
        businessId: null,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        changes: {},
        metadata: {},
      },
    });

    // A platform-admin browse row that must NEVER surface to the BO.
    await raw.auditLog.create({
      data: {
        actorType: 'platform_admin',
        actorId: null,
        ownerId: null,
        businessId: null,
        action: 'admin.browse.activity_log',
        entityType: 'business',
        entityId: businessId,
        changes: {},
        metadata: {},
      },
    });

    const res = await request(server())
      .get(`/v1/portal/businesses/${businessId}/activity-log`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.page).toBe(1);
    const actions = res.body.data.map((r: any) => r.action);
    expect(actions).toContain('product.update'); // business row
    expect(actions).toContain('auth.login'); // owner's own auth event
    // No platform rows leak into the BO view.
    expect(
      res.body.data.some((r: any) => r.actorType === 'platform_admin'),
    ).toBe(false);

    // Filter by action.
    const filtered = await request(server())
      .get(`/v1/portal/businesses/${businessId}/activity-log`)
      .query({ action: 'product.update' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      filtered.body.data.every((r: any) => r.action === 'product.update'),
    ).toBe(true);
    expect(filtered.body.data.length).toBeGreaterThan(0);

    // The read itself is a sensitive event → an audit row was appended.
    const readRows = await raw.auditLog.findMany({
      where: { action: 'audit.activity_log_read', businessId },
    });
    expect(readRows.length).toBeGreaterThanOrEqual(1);
    expect(readRows[0].actorType).toBe('owner');
  });

  it('rejects a platform_admin actorType filter (422) and 404s a foreign business', async () => {
    const a = await ctx();
    const b = await ctx();

    await request(server())
      .get(`/v1/portal/businesses/${a.businessId}/activity-log`)
      .query({ actorType: 'platform_admin' })
      .set('Authorization', `Bearer ${a.token}`)
      .expect(422);

    await request(server())
      .get(`/v1/portal/businesses/${a.businessId}/activity-log`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
  });

  /** Helper: resolve a branch's businessId via raw (test convenience). */
  async function businessOf(branchId: string): Promise<string> {
    const branch = await raw.branch.findUniqueOrThrow({
      where: { id: branchId },
    });
    return branch.businessId;
  }
});
