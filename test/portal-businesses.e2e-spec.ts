/*
 * Task 11 — Portal businesses + branches e2e (TDD).
 *
 * Drives the real Nest app over HTTP with supertest. An owner-role access token
 * is minted via AuthService.mintTokenPair so the PortalAuthGuard-protected
 * `/v1/portal/*` routes run in TENANT scope. All portal writes flow through the
 * ScopedPrisma choke point, so tenant isolation, ownerId stamping, soft-delete,
 * and the automatic mutation audit are all exercised end to end.
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
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();

let seq = 0;

/** Seed an active owner + its owner-role user. */
async function seedOwner(maxBusinesses = 5) {
  seq += 1;
  const owner = await raw.owner.create({
    data: {
      name: `Owner ${seq}`,
      email: `owner-${seq}-${Date.now()}@test.com`,
      status: 'active',
      maxBusinesses,
    },
  });
  const user = await raw.user.create({
    data: {
      email: `user-${seq}-${Date.now()}@test.com`,
      role: 'owner',
      ownerId: owner.id,
      passwordHash: 'x', // not exercised — token is minted directly
    },
  });
  return { owner, user };
}

/** A bare `is_demo` business row (excluded from the maxBusinesses cap). */
async function seedDemoBusiness(ownerId: string) {
  return raw.business.create({
    data: {
      ownerId,
      name: 'Kape Diaria (Demo)',
      type: 'mixed',
      currency: 'PHP',
      taxRate: '0.12',
      serviceChargeRate: '0.05',
      isDemo: true,
    },
  });
}

const validBusiness = () => ({
  name: 'Aling Nena Store',
  type: 'retail',
  currency: 'PHP',
  taxRate: 0.12,
  serviceChargeRate: 0,
  dayStartTime: '06:00',
});

describe('Portal businesses + branches (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  async function ownerToken(maxBusinesses = 5) {
    const { owner, user } = await seedOwner(maxBusinesses);
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    return { owner, user, token: accessToken };
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
  // Guard
  // =========================================================================

  it('rejects unauthenticated access to portal routes', async () => {
    await request(server()).get('/v1/portal/businesses').expect(401);
  });

  it('rejects a suspended owner', async () => {
    const { owner, user } = await seedOwner();
    await raw.owner.update({
      where: { id: owner.id },
      data: { status: 'suspended', suspendedAt: new Date() },
    });
    const { accessToken } = await auth.mintTokenPair(
      user.id,
      'owner',
      owner.id,
    );
    await request(server())
      .get('/v1/portal/businesses')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  it('rejects a platform_admin (no owner) from portal routes', async () => {
    seq += 1;
    const admin = await raw.user.create({
      data: {
        email: `padmin-${seq}-${Date.now()}@test.com`,
        role: 'platform_admin',
        passwordHash: 'x',
      },
    });
    const { accessToken } = await auth.mintTokenPair(
      admin.id,
      'platform_admin',
    );
    await request(server())
      .get('/v1/portal/businesses')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  // =========================================================================
  // Business create + validation
  // =========================================================================

  it('creates a business (ownerId forced, non-demo) and auto-audits it', async () => {
    const { owner, token } = await ownerToken();

    const res = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send(validBusiness())
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Aling Nena Store');
    expect(res.body.type).toBe('retail');
    expect(res.body.currency).toBe('PHP');
    // Decimal rates surface as numbers, not strings.
    expect(res.body.taxRate).toBe(0.12);
    expect(res.body.serviceChargeRate).toBe(0);
    expect(res.body.isDemo).toBe(false);

    // ownerId is stamped by the choke point (never from the client).
    const biz = await raw.business.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(biz.ownerId).toBe(owner.id);

    // Tenant mutation → automatic audit row (actor = owner).
    const audit = await raw.auditLog.findMany({
      where: { action: 'business.create', entityId: res.body.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].actorType).toBe('owner');
    expect(audit[0].businessId).toBe(res.body.id);
  });

  it('ignores a client-supplied ownerId / isDemo (mass-assignment guard)', async () => {
    const { owner, token } = await ownerToken();
    const res = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBusiness(), ownerId: 'someone-else', isDemo: true })
      .expect(201);

    const biz = await raw.business.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(biz.ownerId).toBe(owner.id);
    expect(biz.isDemo).toBe(false);
  });

  it('rejects a non-PHP currency (§7 PHP-only)', async () => {
    const { token } = await ownerToken();
    await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBusiness(), currency: 'USD' })
      .expect(422);
  });

  it('rejects a taxRate outside [0, 1)', async () => {
    const { token } = await ownerToken();
    await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBusiness(), taxRate: 1 })
      .expect(422);
  });

  it('rejects a malformed dayStartTime', async () => {
    const { token } = await ownerToken();
    await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBusiness(), dayStartTime: '6am' })
      .expect(422);
  });

  // =========================================================================
  // maxBusinesses cap (demo excluded)
  // =========================================================================

  it('enforces maxBusinesses, excluding demo businesses from the count', async () => {
    const { owner, token } = await ownerToken(1);
    // A demo business exists but must NOT count against the cap.
    await seedDemoBusiness(owner.id);

    // First real business is allowed (0 non-demo < 1).
    await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send(validBusiness())
      .expect(201);

    // Second real business exceeds the cap (1 non-demo >= 1).
    const res = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send(validBusiness())
      .expect(403);
    expect(res.body.code).toBe('max_businesses_reached');
  });

  // =========================================================================
  // Business read / update / soft-delete
  // =========================================================================

  it('lists, gets, patches, and soft-deletes a business', async () => {
    const { token } = await ownerToken();
    const created = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send(validBusiness())
      .expect(201);
    const id = created.body.id;

    // List.
    const list = await request(server())
      .get('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((b: any) => b.id)).toContain(id);

    // Get one.
    const one = await request(server())
      .get(`/v1/portal/businesses/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(one.body.id).toBe(id);

    // Patch.
    await request(server())
      .patch(`/v1/portal/businesses/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed', taxRate: 0.1 })
      .expect(200);
    const patched = await raw.business.findUniqueOrThrow({ where: { id } });
    expect(patched.name).toBe('Renamed');
    expect(Number(patched.taxRate)).toBe(0.1);

    // Soft-delete (archive).
    await request(server())
      .delete(`/v1/portal/businesses/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const archived = await raw.business.findUniqueOrThrow({ where: { id } });
    expect(archived.deletedAt).not.toBeNull();

    // Gone from reads.
    await request(server())
      .get(`/v1/portal/businesses/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const listAfter = await request(server())
      .get('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listAfter.body.map((b: any) => b.id)).not.toContain(id);
  });

  it('treats an empty PATCH as a no-op (writes no update audit row)', async () => {
    const { token } = await ownerToken();
    const created = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send(validBusiness())
      .expect(201);
    const id = created.body.id;

    await request(server())
      .patch(`/v1/portal/businesses/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);

    const audit = await raw.auditLog.findMany({
      where: { action: 'business.update', entityId: id },
    });
    expect(audit.length).toBe(0);
  });

  // =========================================================================
  // Tenant isolation
  // =========================================================================

  it('never surfaces another owner’s business', async () => {
    const a = await ownerToken();
    const b = await ownerToken();

    const created = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${a.token}`)
      .send(validBusiness())
      .expect(201);
    const aBizId = created.body.id;

    // B's list is empty of A's business.
    const bList = await request(server())
      .get('/v1/portal/businesses')
      .set('Authorization', `Bearer ${b.token}`)
      .expect(200);
    expect(bList.body.map((x: any) => x.id)).not.toContain(aBizId);

    // B cannot GET / PATCH / DELETE A's business (404, not 403 — no existence leak).
    await request(server())
      .get(`/v1/portal/businesses/${aBizId}`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
    await request(server())
      .patch(`/v1/portal/businesses/${aBizId}`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'hijack' })
      .expect(404);
    await request(server())
      .delete(`/v1/portal/businesses/${aBizId}`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
  });

  // =========================================================================
  // Branches
  // =========================================================================

  async function createBusiness(token: string): Promise<string> {
    const res = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send(validBusiness())
      .expect(201);
    return res.body.id;
  }

  it('creates two branches, lists, gets, patches, and soft-deletes them', async () => {
    const { token } = await ownerToken();
    const businessId = await createBusiness(token);

    const mkt = await request(server())
      .post(`/v1/portal/businesses/${businessId}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Marikit', code: 'MKT', address: '123 Marikina' })
      .expect(201);
    expect(mkt.body.code).toBe('MKT');
    expect(mkt.body.businessId).toBe(businessId);

    await request(server())
      .post(`/v1/portal/businesses/${businessId}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bayanihan', code: 'BYN', address: '456 Bayanihan' })
      .expect(201);

    // List.
    const list = await request(server())
      .get(`/v1/portal/businesses/${businessId}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const codes = list.body.map((br: any) => br.code);
    expect(codes).toEqual(expect.arrayContaining(['MKT', 'BYN']));

    // Get one.
    const one = await request(server())
      .get(`/v1/portal/branches/${mkt.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(one.body.id).toBe(mkt.body.id);

    // Patch.
    await request(server())
      .patch(`/v1/portal/branches/${mkt.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Marikit Main' })
      .expect(200);

    // Soft-delete.
    await request(server())
      .delete(`/v1/portal/branches/${mkt.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(server())
      .get(`/v1/portal/branches/${mkt.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rejects a duplicate branch code within the same business (422)', async () => {
    const { token } = await ownerToken();
    const businessId = await createBusiness(token);

    await request(server())
      .post(`/v1/portal/businesses/${businessId}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Marikit', code: 'MKT', address: 'a' })
      .expect(201);

    await request(server())
      .post(`/v1/portal/businesses/${businessId}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Marikit 2', code: 'MKT', address: 'b' })
      .expect(422);
  });

  it('rejects a malformed branch code (lowercase / too long)', async () => {
    const { token } = await ownerToken();
    const businessId = await createBusiness(token);

    await request(server())
      .post(`/v1/portal/businesses/${businessId}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', code: 'mkt', address: 'a' })
      .expect(422);

    await request(server())
      .post(`/v1/portal/businesses/${businessId}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', code: 'TOOLONG', address: 'a' })
      .expect(422);
  });

  it('does not let an owner add or list branches under another owner’s business', async () => {
    const a = await ownerToken();
    const b = await ownerToken();
    const aBiz = await createBusiness(a.token);

    // B tries to create a branch under A's business → 404.
    await request(server())
      .post(`/v1/portal/businesses/${aBiz}/branches`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'x', code: 'HAX', address: 'a' })
      .expect(404);

    // B tries to list A's branches → 404.
    await request(server())
      .get(`/v1/portal/businesses/${aBiz}/branches`)
      .set('Authorization', `Bearer ${b.token}`)
      .expect(404);
  });

  it('allows the same branch code in two different businesses of the same owner', async () => {
    const { token } = await ownerToken();
    const biz1 = await createBusiness(token);
    // Second business needs a higher cap; default owner cap is 5.
    const res2 = await request(server())
      .post('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validBusiness(), name: 'Second' })
      .expect(201);
    const biz2 = res2.body.id;

    await request(server())
      .post(`/v1/portal/businesses/${biz1}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main', code: 'MAIN', address: 'a' })
      .expect(201);
    // Same code, different business → allowed (unique is per-business).
    await request(server())
      .post(`/v1/portal/businesses/${biz2}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main', code: 'MAIN', address: 'b' })
      .expect(201);
  });
});
