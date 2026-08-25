/*
 * Task 10 — Admin module (owner provisioning, two-tier suspension, audited
 * read-only tenant browse) e2e (TDD).
 *
 * Drives the real Nest app over HTTP with supertest. A platform_admin access
 * token is minted via AuthService.mintTokenPair so the AdminGuard-protected
 * `/v1/admin/*` routes are exercised end to end. Owner/user CRUD and browse
 * auditing are asserted against the raw client; the BO-invisibility invariant
 * is asserted at the ScopedPrisma tenant-scope client level (the BO activity-log
 * HTTP endpoint is Task 14, so we assert directly against the choke point).
 *
 * Dynamically-shaped seed rows and JSON metadata are inherently `any`-typed, so
 * the unsafe-* rules are disabled file-wide (pattern shared with other e2e specs).
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
import { MailService } from '../src/mail/mail.service';
import { createScopedPrisma } from '../src/prisma/scoped-prisma';
import {
  requestContext,
  RequestContext,
} from '../src/common/context/request-context';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();

let seq = 0;

async function seedAdmin() {
  seq += 1;
  return raw.user.create({
    data: {
      email: `admin-${seq}-${Date.now()}@test.com`,
      role: 'platform_admin',
      passwordHash: 'x', // not exercised — token is minted directly
    },
  });
}

/** Seed an owner with a business + branch + a couple of tenant audit rows. */
async function seedOwnerTree(label: string) {
  seq += 1;
  const owner = await raw.owner.create({
    data: {
      name: `Owner ${label}`,
      email: `owner-${label}-${seq}-${Date.now()}@test.com`,
      status: 'active',
    },
  });
  const business = await raw.business.create({
    data: {
      ownerId: owner.id,
      name: `Biz ${label}`,
      type: 'retail',
      taxRate: 0.12,
    },
  });
  const branch = await raw.branch.create({
    data: {
      businessId: business.id,
      name: `Branch ${label}`,
      code: `B-${label}`,
      address: 'x',
    },
  });
  // A genuine tenant activity row the BO would legitimately see.
  await raw.auditLog.create({
    data: {
      actorType: 'owner',
      actorId: null,
      ownerId: owner.id,
      businessId: business.id,
      branchId: branch.id,
      action: 'product.create',
      entityType: 'product',
      entityId: null,
      changes: {},
      metadata: {},
    },
  });
  return { owner, business, branch };
}

/** Build a tenant-scope request context for the given owner. */
function ownerCtx(ownerId: string): RequestContext {
  return {
    requestId: 'req-' + Math.random().toString(16).slice(2),
    scope: 'tenant',
    actor: { type: 'owner', id: ownerId },
    ownerId,
    businessId: null,
    branchId: null,
    terminalCode: null,
    sessionId: null,
    ip: '127.0.0.1',
    userAgent: 'jest',
    deviceTimestamp: null,
  };
}

function runAs<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return requestContext.run(ctx, async () => await fn());
}

describe('Admin module (e2e)', () => {
  let app: INestApplication;
  let mail: MailService;
  let auth: AuthService;
  const scoped = createScopedPrisma(raw as unknown as PrismaService);

  async function adminToken(): Promise<string> {
    const admin = await seedAdmin();
    const { accessToken } = await auth.mintTokenPair(
      admin.id,
      'platform_admin',
    );
    return accessToken;
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
    mail = app.get(MailService);
    auth = app.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
    mail.sentMailbox.length = 0;
  });

  const server = () => app.getHttpServer();

  // =========================================================================
  // Guard: unauthenticated / non-admin cannot reach admin routes
  // =========================================================================

  it('rejects unauthenticated access to admin routes', async () => {
    await request(server()).get('/v1/admin/owners').expect(401);
  });

  it('rejects a non-admin (owner-role) token', async () => {
    const ownerUser = await raw.user.create({
      data: {
        email: `ownuser-${Date.now()}@test.com`,
        role: 'owner',
        passwordHash: 'x',
      },
    });
    const { accessToken } = await auth.mintTokenPair(ownerUser.id, 'owner');
    await request(server())
      .get('/v1/admin/owners')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  // =========================================================================
  // Owner provisioning: creates owner + user (no password) + sends invite
  // =========================================================================

  it('creates an owner + user (no password) and sends the invite mail', async () => {
    const token = await adminToken();

    const res = await request(server())
      .post('/v1/admin/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme Corp', email: 'boss@acme.test', maxBusinesses: 3 })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Acme Corp');
    expect(res.body.email).toBe('boss@acme.test');
    expect(res.body.maxBusinesses).toBe(3);

    // Owner row created.
    const owner = await raw.owner.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(owner.email).toBe('boss@acme.test');
    expect(owner.maxBusinesses).toBe(3);

    // User row created, role owner, NO password.
    const user = await raw.user.findUniqueOrThrow({
      where: { email: 'boss@acme.test' },
    });
    expect(user.role).toBe('owner');
    expect(user.ownerId).toBe(owner.id);
    expect(user.passwordHash).toBeNull();

    // Invite mail landed in the console mailbox with a raw token link.
    expect(mail.sentMailbox.length).toBe(1);
    expect(mail.sentMailbox[0].to).toBe('boss@acme.test');
    expect(mail.sentMailbox[0].html).toContain('/invite/accept?token=');

    // An invite auth_token was minted for the user.
    const tokens = await raw.authToken.findMany({
      where: { userId: user.id, kind: 'invite' },
    });
    expect(tokens.length).toBe(1);

    // EVERY admin mutation produces an admin audit row (§11).
    const audit = await raw.auditLog.findMany({
      where: { action: 'admin.owner.create', entityId: owner.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].actorType).toBe('platform_admin');
    expect(audit[0].entityType).toBe('owner');
  });

  // =========================================================================
  // Owner list / get / patch
  // =========================================================================

  it('lists owners and gets one by id', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    const list = await request(server())
      .get('/v1/admin/owners')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = list.body.map((o: any) => o.id);
    expect(ids).toContain(a.owner.id);
    expect(ids).toContain(b.owner.id);

    const one = await request(server())
      .get(`/v1/admin/owners/${a.owner.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(one.body.id).toBe(a.owner.id);
    expect(one.body.name).toBe('Owner A');
  });

  it('patches an owner name + maxBusinesses and audits it', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');

    await request(server())
      .patch(`/v1/admin/owners/${a.owner.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed', maxBusinesses: 9 })
      .expect(200);

    const owner = await raw.owner.findUniqueOrThrow({
      where: { id: a.owner.id },
    });
    expect(owner.name).toBe('Renamed');
    expect(owner.maxBusinesses).toBe(9);

    const audit = await raw.auditLog.findMany({
      where: { action: 'admin.owner.update', entityId: a.owner.id },
    });
    expect(audit.length).toBe(1);
  });

  // =========================================================================
  // Two-tier suspension + reinstate
  // =========================================================================

  it('default suspend flips status to suspended and stamps suspendedAt', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');

    await request(server())
      .post(`/v1/admin/owners/${a.owner.id}/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'default' })
      .expect(201);

    const owner = await raw.owner.findUniqueOrThrow({
      where: { id: a.owner.id },
    });
    expect(owner.status).toBe('suspended');
    expect(owner.suspendedAt).not.toBeNull();

    const audit = await raw.auditLog.findMany({
      where: { action: 'admin.owner.suspend', entityId: a.owner.id },
    });
    expect(audit.length).toBe(1);
  });

  it('hard suspend flips status to hard_suspended and stamps suspendedAt', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');

    await request(server())
      .post(`/v1/admin/owners/${a.owner.id}/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'hard' })
      .expect(201);

    const owner = await raw.owner.findUniqueOrThrow({
      where: { id: a.owner.id },
    });
    expect(owner.status).toBe('hard_suspended');
    expect(owner.suspendedAt).not.toBeNull();
  });

  it('reinstate flips status back to active and clears suspendedAt', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');
    await raw.owner.update({
      where: { id: a.owner.id },
      data: { status: 'suspended', suspendedAt: new Date() },
    });

    await request(server())
      .post(`/v1/admin/owners/${a.owner.id}/reinstate`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);

    const owner = await raw.owner.findUniqueOrThrow({
      where: { id: a.owner.id },
    });
    expect(owner.status).toBe('active');
    expect(owner.suspendedAt).toBeNull();

    const audit = await raw.auditLog.findMany({
      where: { action: 'admin.owner.reinstate', entityId: a.owner.id },
    });
    expect(audit.length).toBe(1);
  });

  it('rejects an invalid suspend tier', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');
    await request(server())
      .post(`/v1/admin/owners/${a.owner.id}/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'nonsense' })
      .expect(422);
  });

  // =========================================================================
  // Read-only tenant browse — returns the target owner's data
  // =========================================================================

  it('browses an owner businesses and audits with businessId null', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');
    const b = await seedOwnerTree('B');

    const res = await request(server())
      .get(`/v1/admin/owners/${a.owner.id}/businesses`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = res.body.map((x: any) => x.id);
    expect(ids).toContain(a.business.id);
    expect(ids).not.toContain(b.business.id);

    // Browse writes a platform-side admin audit row with businessId = null.
    const audit = await raw.auditLog.findMany({
      where: { action: 'admin.browse.businesses', entityId: a.owner.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].actorType).toBe('platform_admin');
    expect(audit[0].businessId).toBeNull();
    expect((audit[0].metadata as any).browsedBusinessId).toBeUndefined();
  });

  it('browses a business branches and audits with businessId null + browsedBusinessId', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');

    const res = await request(server())
      .get(`/v1/admin/businesses/${a.business.id}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = res.body.map((x: any) => x.id);
    expect(ids).toContain(a.branch.id);

    const audit = await raw.auditLog.findMany({
      where: { action: 'admin.browse.branches', entityId: a.business.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].businessId).toBeNull();
    expect((audit[0].metadata as any).browsedBusinessId).toBe(a.business.id);
  });

  it('browses a business activity-log (paginated) and audits with businessId null', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');

    const res = await request(server())
      .get(`/v1/admin/businesses/${a.business.id}/activity-log`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // Paginated envelope with the tenant's own product.create row.
    expect(Array.isArray(res.body.data)).toBe(true);
    const actions = res.body.data.map((r: any) => r.action);
    expect(actions).toContain('product.create');
    expect(res.body.page).toBe(1);

    const audit = await raw.auditLog.findMany({
      where: { action: 'admin.browse.activity_log', entityId: a.business.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].businessId).toBeNull();
    expect((audit[0].metadata as any).browsedBusinessId).toBe(a.business.id);
  });

  // =========================================================================
  // Browse is read-only: an accidental tenant WRITE in platform scope throws
  // (mapped to 403 platform_write_forbidden). We assert at the client level.
  // =========================================================================

  it('a tenant WRITE in platform scope throws platform_write_forbidden', async () => {
    const a = await seedOwnerTree('A');
    const platformCtx: RequestContext = {
      ...ownerCtx(a.owner.id),
      scope: 'platform',
      actor: { type: 'platform_admin', id: a.owner.id },
      ownerId: null,
    };
    await expect(
      runAs(platformCtx, () =>
        scoped.branch.update({
          where: { id: a.branch.id },
          data: { name: 'hacked' },
        }),
      ),
    ).rejects.toThrow(/PlatformWriteError/);
  });

  // =========================================================================
  // BO-invisibility: after an admin browse, the BO's own tenant-scope
  // activity-log query surfaces NO platform_admin / platform-read row, while
  // the admin-side view shows it.
  // =========================================================================

  it('platform browse rows are invisible to the BO tenant-scope activity-log', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');

    // Admin browses the business activity log — writes a platform-read row.
    await request(server())
      .get(`/v1/admin/businesses/${a.business.id}/activity-log`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The admin-side raw view shows the platform-read row (businessId null).
    const adminView = await raw.auditLog.findMany({
      where: { action: 'admin.browse.activity_log' },
    });
    expect(adminView.length).toBe(1);
    expect(adminView[0].actorType).toBe('platform_admin');

    // The BO's OWN tenant-scope activity-log (via ScopedPrisma tenant scope,
    // the exact choke point Task 14's HTTP endpoint will use) sees ZERO
    // platform_admin rows — only their own tenant activity.
    const boView = await runAs(ownerCtx(a.owner.id), () =>
      scoped.auditLog.findMany({}),
    );
    expect(boView.length).toBeGreaterThan(0);
    for (const row of boView) {
      expect(row.actorType).not.toBe('platform_admin');
    }
    // Their genuine product.create row IS visible.
    expect(boView.some((r) => r.action === 'product.create')).toBe(true);
    // No admin.browse.* row leaked into the tenant view.
    expect(boView.some((r) => r.action.startsWith('admin.browse'))).toBe(false);
  });

  // =========================================================================
  // Input hardening: bad ids / dates / duplicates map to clean 4xx (not 500),
  // and a browse of a non-existent entity 404s without writing a phantom audit
  // row (rather than silently returning an empty 200).
  // =========================================================================

  // Valid v4-format UUID that will never be seeded — exercises the 404 path
  // (passes ParseUUIDPipe, then misses on lookup).
  const MISSING_UUID = '11111111-1111-4111-8111-111111111111';

  it('rejects a duplicate owner email with 409 and creates no second owner', async () => {
    const token = await adminToken();

    await request(server())
      .post('/v1/admin/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'First', email: 'dupe@acme.test', maxBusinesses: 1 })
      .expect(201);

    const res = await request(server())
      .post('/v1/admin/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Second', email: 'dupe@acme.test', maxBusinesses: 1 })
      .expect(409);
    expect(res.body.code).toBe('email_taken');

    // The rolled-back transaction left exactly one owner with that email.
    const owners = await raw.owner.findMany({
      where: { email: 'dupe@acme.test' },
    });
    expect(owners.length).toBe(1);
    expect(owners[0].name).toBe('First');
  });

  it('returns 404 for a non-existent owner', async () => {
    const token = await adminToken();
    await request(server())
      .get(`/v1/admin/owners/${MISSING_UUID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rejects a malformed (non-uuid) owner id with 400', async () => {
    const token = await adminToken();
    await request(server())
      .get('/v1/admin/owners/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('404s a browse of a non-existent owner and writes no audit row', async () => {
    const token = await adminToken();
    await request(server())
      .get(`/v1/admin/owners/${MISSING_UUID}/businesses`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    const audit = await raw.auditLog.findMany({
      where: { action: 'admin.browse.businesses' },
    });
    expect(audit.length).toBe(0);
  });

  it('404s a branches browse of a non-existent business', async () => {
    const token = await adminToken();
    await request(server())
      .get(`/v1/admin/businesses/${MISSING_UUID}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rejects an invalid from-date on the activity-log browse with 422', async () => {
    const token = await adminToken();
    const a = await seedOwnerTree('A');
    await request(server())
      .get(`/v1/admin/businesses/${a.business.id}/activity-log`)
      .query({ from: 'not-a-date' })
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });
});
