import { ObjectStorageService } from '../src/media/object-storage.service';
import { PurgeService } from '../src/portal/lifecycle/purge.service';
/*
 * Task 15 — Portal stock (receive / adjust / levels) e2e (TDD).
 *
 * Owner-role token (tenant scope via PortalAuthGuard). Exercises the shared
 * StockService via the portal endpoints: receive (levels + movements + latest
 * cost + expiry batches, grouped by one operation ref), adjust (absolute target,
 * reason, self-ref movement), variant-integrity rules, tenant isolation, and the
 * qty>=0 invariant under concurrent adjustments.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
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

describe('Account lifecycle (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  async function ownerToken() {
    const { owner, user } = await seedOwner();
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    return { owner, token: accessToken };
  }

  async function ctx() {
    const { token } = await ownerToken();
    const biz = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Biz', type: 'retail', currency: 'PHP', taxRate: 0.12 })
      .expect(201);
    const branch = await request(server())
      .post(`/v1/portal/businesses/${biz.body.id}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main', code: 'MN', address: 'x' })
      .expect(201);
    const cat = await request(server())
      .post(`/v1/portal/businesses/${biz.body.id}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Grocery' })
      .expect(201);
    return {
      token,
      businessId: biz.body.id,
      branchId: branch.body.id,
      categoryId: cat.body.id,
    };
  }

  async function makeProduct(
    token: string,
    businessId: string,
    categoryId: string,
    over: Record<string, unknown> = {},
  ): Promise<any> {
    const res = await request(server())
      .post(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        categoryId,
        name: `P-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        priceC: 10000,
        trackStock: true,
        ...over,
      })
      .expect(201);
    return res.body;
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

  afterEach(() => jest.restoreAllMocks());

  beforeEach(async () => {
    await resetDb();
  });

  const server = () => app.getHttpServer();

  it('exports an owner-only CSV zip and requires it before confirmed closure', async () => {
    const c = await ctx();
    const other = await ctx();
    await makeProduct(c.token, c.businessId, c.categoryId, {
      name: 'Only Mine',
    });
    await makeProduct(other.token, other.businessId, other.categoryId, {
      name: 'Other Private Product',
    });
    const exportResponse = await request(server())
      .get('/v1/portal/account/export')
      .set('Authorization', `Bearer ${c.token}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(exportResponse.headers['content-type']).toContain('application/zip');
    expect(exportResponse.body.toString()).toContain('catalog.csv');
    expect(exportResponse.body.toString()).toContain('Only Mine');
    expect(exportResponse.body.toString()).not.toContain(
      'Other Private Product',
    );
    expect(exportResponse.body.toString()).not.toContain('passwordHash');
    const exportId = exportResponse.headers['x-export-id'];
    expect(exportId).toBeTruthy();
    const close = (token: string, body: object) =>
      request(server())
        .post('/v1/portal/account/closure')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    await close(other.token, {
      confirmation: 'CLOSE MY ACCOUNT',
      exportId,
    }).expect(422);
    await close(c.token, { confirmation: 'yes', exportId }).expect(422);
    const closed = await close(c.token, {
      confirmation: 'CLOSE MY ACCOUNT',
      exportId,
    }).expect(201);
    expect(
      new Date(closed.body.purgeAfter).getTime() -
        new Date(closed.body.closedAt).getTime(),
    ).toBe(90 * 86400000);
    await request(server())
      .get('/v1/portal/businesses')
      .set('Authorization', `Bearer ${c.token}`)
      .expect(403);
    const business = await raw.business.findUniqueOrThrow({
      where: { id: c.businessId },
    });
    expect(
      await raw.refreshToken.count({
        where: { user: { ownerId: business.ownerId }, revokedAt: null },
      }),
    ).toBe(0);
  });
  it('resets only demo business, preserves real data, and replays the client UUID', async () => {
    const c = await ctx();
    const business = await raw.business.findUniqueOrThrow({
      where: { id: c.businessId },
    });
    const demo = await raw.business.create({
      data: {
        ownerId: business.ownerId,
        name: 'Demo',
        type: 'retail',
        currency: 'PHP',
        taxRate: 0.12,
        isDemo: true,
      },
    });
    const body = { id: randomUUID(), confirmation: 'RESET DEMO' };
    const reset = (id: string) =>
      request(server())
        .post(`/v1/portal/businesses/${id}/demo-reset`)
        .set('Authorization', `Bearer ${c.token}`)
        .send(body);
    await reset(c.businessId).expect(422);
    const first = await reset(demo.id).expect(201);
    const replay = await reset(demo.id).expect(201);
    expect(first.body).toEqual(replay.body);
    expect(first.body.businessId).not.toBe(demo.id);
    expect(
      await raw.product.count({ where: { businessId: first.body.businessId } }),
    ).toBeGreaterThan(0);
    expect(
      (await raw.business.findUniqueOrThrow({ where: { id: c.businessId } }))
        .deletedAt,
    ).toBeNull();
  });
  it('purges only after both ninety days and the recorded deadline, preserving every other owner', async () => {
    const c = await ctx(),
      other = await ctx();
    await makeProduct(c.token, c.businessId, c.categoryId);
    const ownerId = (
      await raw.business.findUniqueOrThrow({ where: { id: c.businessId } })
    ).ownerId;
    const staff = await raw.user.create({ data: { role: 'cashier', ownerId } });
    await raw.staffProfile.create({
      data: {
        userId: staff.id,
        businessId: c.businessId,
        name: 'Ana',
        status: 'pending',
        branches: { create: [{ branchId: c.branchId }] },
      },
    });
    await raw.staffChallenge.create({
      data: {
        userId: staff.id,
        kind: 'cashier_setup',
        pinHash: 'hash-only',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const terminal = await raw.terminal.create({
      data: { branchId: c.branchId, name: 'Register', code: 'T1' },
    });
    const ownerUser = await raw.user.findFirstOrThrow({
      where: { ownerId, role: 'owner' },
    });
    for (const userId of [ownerUser.id, staff.id]) {
      await raw.operatorSession.create({
        data: {
          userId,
          terminalId: terminal.id,
          branchId: c.branchId,
          tokenHash: randomUUID(),
          lastActivityAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      });
    }
    await raw.owner.update({
      where: { id: ownerId },
      data: {
        status: 'closed',
        closedAt: new Date(),
        purgeAfter: new Date(Date.now() - 86400000),
      },
    });
    const job = app.get(PurgeService);
    expect(await job.runDue()).toBe(0);
    await expect(
      raw.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('sentry.purge_owner', ${ownerId}, true)`;
        await tx.auditLog.deleteMany({ where: { ownerId } });
      }),
    ).rejects.toThrow('append-only');
    await raw.owner.update({
      where: { id: ownerId },
      data: {
        closedAt: new Date(Date.now() - 91 * 86400000),
        purgeAfter: new Date(Date.now() + 86400000),
      },
    });
    expect(await job.runDue()).toBe(0);
    await raw.owner.update({
      where: { id: ownerId },
      data: { purgeAfter: new Date(Date.now() - 86400000) },
    });
    expect(await job.runDue()).toBe(1);
    expect(await job.runDue()).toBe(0);
    expect(await raw.owner.findUnique({ where: { id: ownerId } })).toBeNull();
    expect(await raw.auditLog.count({ where: { ownerId } })).toBe(0);
    expect(await raw.user.findUnique({ where: { id: staff.id } })).toBeNull();
    expect(await raw.operatorSession.count()).toBe(0);
    expect(await raw.staffChallenge.count()).toBe(0);
    expect(await raw.staffProfile.count()).toBe(0);
    expect(
      await raw.business.findUnique({ where: { id: other.businessId } }),
    ).not.toBeNull();
  });

  it('provides audited, read-only admin inspection without device secrets or cross-business rows', async () => {
    const c = await ctx(),
      other = await ctx();
    await makeProduct(c.token, c.businessId, c.categoryId, { name: 'Visible' });
    await makeProduct(other.token, other.businessId, other.categoryId, {
      name: 'Other',
    });
    const admin = await raw.user.create({
      data: {
        email: 'inspector@test.com',
        role: 'platform_admin',
        passwordHash: 'x',
      },
    });
    const { accessToken } = await auth.mintTokenPair(
      admin.id,
      'platform_admin',
    );
    const get = (path: string, token = accessToken) =>
      request(server()).get(path).set('Authorization', `Bearer ${token}`);
    const report = await get(
      `/v1/admin/businesses/${c.businessId}/inspect?section=catalog`,
    ).expect(200);
    expect(report.body.total).toBe(1);
    expect(report.body.data[0].name).toBe('Visible');
    await get('/v1/admin/metrics', c.token).expect(403);
    const metrics = await get('/v1/admin/metrics').expect(200);
    expect(metrics.body.owners.total).toBe(2);
    await get(
      `/v1/admin/businesses/${c.businessId}/inspect?section=users`,
    ).expect(422);
    await raw.terminal.create({
      data: {
        branchId: c.branchId,
        name: 'Terminal',
        code: 'T',
        deviceTokenHash: 'PRIVATE-TOKEN-HASH',
      },
    });
    const terminals = await get(
      `/v1/admin/businesses/${c.businessId}/inspect?section=terminals`,
    ).expect(200);
    expect(JSON.stringify(terminals.body)).not.toContain('PRIVATE-TOKEN-HASH');
    expect(terminals.body.data[0].paired).toBe(true);
    expect(
      await raw.auditLog.count({
        where: { action: 'admin.browse.inspect', entityId: c.businessId },
      }),
    ).toBe(2);
  });
  it('does not allow ordinary admin reinstatement or suspension to bypass account closure', async () => {
    const { owner } = await ownerToken();
    await raw.owner.update({
      where: { id: owner.id },
      data: {
        status: 'closed',
        closedAt: new Date(),
        purgeAfter: new Date(Date.now() + 90 * 86400000),
      },
    });
    const admin = await raw.user.create({
      data: { email: 'closed-admin@test.com', role: 'platform_admin' },
    });
    const { accessToken } = await auth.mintTokenPair(
      admin.id,
      'platform_admin',
    );
    for (const path of ['reinstate', 'suspend'])
      await request(server())
        .post(`/v1/admin/owners/${owner.id}/${path}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ tier: 'default' })
        .expect(422);
    expect(
      (await raw.owner.findUniqueOrThrow({ where: { id: owner.id } })).status,
    ).toBe('closed');
  });

  it('queues object cleanup durably and removes user notifications at purge, retrying storage failures', async () => {
    const c = await ctx();
    const b = await raw.business.findUniqueOrThrow({
        where: { id: c.businessId },
      }),
      user = await raw.user.findFirstOrThrow({ where: { ownerId: b.ownerId } });
    const key = `${b.id}/logo/example.webp`;
    await raw.business.update({ where: { id: b.id }, data: { logoPath: key } });
    await raw.notification.create({
      data: {
        recipientType: 'user',
        recipientId: user.id,
        type: 'low_stock',
        title: 'Private',
        body: 'Private',
      },
    });
    await raw.owner.update({
      where: { id: b.ownerId },
      data: {
        status: 'closed',
        closedAt: new Date(Date.now() - 91 * 86400000),
        purgeAfter: new Date(Date.now() - 86400000),
      },
    });
    const job = app.get(PurgeService),
      storage = app.get(ObjectStorageService);
    const configured = jest
      .spyOn(storage, 'configured', 'get')
      .mockReturnValue(false);
    expect(await job.runDue()).toBe(1);
    expect(
      await raw.notification.count({ where: { recipientId: user.id } }),
    ).toBe(0);
    const queued = await raw.jobDelivery.findFirstOrThrow({
      where: { jobKey: { startsWith: 'purge-media:' } },
    });
    expect(JSON.stringify(queued.payload)).toContain(key);
    configured.mockReturnValue(true);
    const remove = jest
      .spyOn(storage, 'remove')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    await job.runDue();
    expect(
      await raw.jobDelivery.findUnique({ where: { id: queued.id } }),
    ).not.toBeNull();
    await job.runDue();
    expect(
      await raw.jobDelivery.findUnique({ where: { id: queued.id } }),
    ).toBeNull();
    expect(remove).toHaveBeenCalledWith(b.id, key);
    remove.mockRestore();
    configured.mockRestore();
  });
  it('rotates failed cleanup jobs so newer manifests are not starved', async () => {
    const storage = app.get(ObjectStorageService);
    jest.spyOn(storage, 'configured', 'get').mockReturnValue(true);
    const remove = jest.spyOn(storage, 'remove').mockResolvedValue(undefined);
    const old = new Date(Date.now() - 2000),
      recent = new Date(Date.now() - 1000),
      businessId = randomUUID();
    await raw.jobDelivery.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        jobKey: `media-cleanup:broken-${i}`,
        payload: {},
        updatedAt: old,
      })),
    });
    const valid = await raw.jobDelivery.create({
      data: {
        jobKey: 'media-cleanup:valid',
        updatedAt: recent,
        payload: {
          objects: [{ businessId, key: `${businessId}/logo/test.webp` }],
        },
      },
    });
    await app.get(PurgeService).runDue();
    expect(remove).not.toHaveBeenCalled();
    await app.get(PurgeService).runDue();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(
      await raw.jobDelivery.findUnique({ where: { id: valid.id } }),
    ).toBeNull();
  });
  it('isolates a corrupt owner purge and still cleans another due owner', async () => {
    const corrupt = await ctx(),
      keep = await ctx(),
      due = await ctx();
    const p = await makeProduct(
      corrupt.token,
      corrupt.businessId,
      corrupt.categoryId,
    );
    // Simulate pre-existing relational corruption that normal scoped writes
    // cannot create: another tenant references the closing tenant's product.
    await raw.branchStock.create({
      data: { branchId: keep.branchId, productId: p.id, qty: 1 },
    });
    const owners = await raw.business.findMany({
      where: { id: { in: [corrupt.businessId, due.businessId] } },
      select: { ownerId: true },
    });
    await raw.owner.updateMany({
      where: { id: { in: owners.map((o) => o.ownerId) } },
      data: {
        status: 'closed',
        closedAt: new Date(Date.now() - 91 * 86400000),
        purgeAfter: new Date(Date.now() - 86400000),
      },
    });
    expect(await app.get(PurgeService).runDue()).toBe(1);
    expect(
      await raw.business.findUnique({ where: { id: corrupt.businessId } }),
    ).not.toBeNull();
    expect(
      await raw.business.findUnique({ where: { id: due.businessId } }),
    ).toBeNull();
    expect(
      await raw.business.findUnique({ where: { id: keep.businessId } }),
    ).not.toBeNull();
  });
});
