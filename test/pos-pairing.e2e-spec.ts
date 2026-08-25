/*
 * Task 16 — POS pairing + TerminalGuard e2e (TDD).
 *
 * Drives the pairing flow over HTTP: owner sign-in (10-min pairing token) →
 * list businesses/branches → pair (device token + terminal T-code) → use the
 * device token on a TerminalGuard-protected route. Also covers remote/POS unpair
 * and the suspension-aware guard (hard-suspend 401; default-suspend grace).
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashSecret } from '../src/auth/hashing';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Poll for audit rows. Denial audits (403 owner_suspended) are written
 * fire-and-forget by the global exception filter AFTER the response returns, so
 * a synchronous read can race the write.
 */
async function waitForAudit(
  where: object,
  min = 1,
  tries = 40,
): Promise<any[]> {
  for (let i = 0; i < tries; i++) {
    const rows = await raw.auditLog.findMany({ where });
    if (rows.length >= min) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return raw.auditLog.findMany({ where });
}

const PASSWORD = 'S3cret-pw';
let PW_HASH = '';
let seq = 0;

async function seedOwnerTree(
  over: {
    status?: 'active' | 'suspended' | 'hard_suspended' | 'closed';
    suspendedAt?: Date | null;
  } = {},
) {
  seq += 1;
  const owner = await raw.owner.create({
    data: {
      name: `Aling ${seq}`,
      email: `owner-${seq}-${Date.now()}@test.com`,
      status: over.status ?? 'active',
      suspendedAt: over.suspendedAt ?? null,
      maxBusinesses: 5,
    },
  });
  const user = await raw.user.create({
    data: {
      email: `user-${seq}-${Date.now()}@test.com`,
      role: 'owner',
      ownerId: owner.id,
      passwordHash: PW_HASH,
    },
  });
  const business = await raw.business.create({
    data: {
      ownerId: owner.id,
      name: `Biz ${seq}`,
      type: 'retail',
      taxRate: '0.12',
      serviceChargeRate: '0',
    },
  });
  const branch = await raw.branch.create({
    data: { businessId: business.id, name: 'Main', code: 'MN', address: 'x' },
  });
  return { owner, user, business, branch };
}

describe('POS pairing + TerminalGuard (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    PW_HASH = await hashSecret(PASSWORD);
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

  const signIn = (email: string, password = PASSWORD) =>
    request(server()).post('/v1/pos/pairing/sign-in').send({ email, password });

  async function pairToken(t: { user: { email: string } }): Promise<string> {
    const res = await signIn(t.user.email).expect(201);
    return res.body.token;
  }

  /** Full pair; returns { deviceToken, terminalCode, terminalId, body }. */
  async function pair(t: Awaited<ReturnType<typeof seedOwnerTree>>) {
    const token = await pairToken(t);
    const res = await request(server())
      .post('/v1/pos/pairing/pair')
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessId: t.business.id,
        branchId: t.branch.id,
        terminalName: 'Register 1',
      })
      .expect(201);
    const terminal = await raw.terminal.findFirstOrThrow({
      where: { branchId: t.branch.id, code: res.body.terminalCode },
    });
    return {
      deviceToken: res.body.deviceToken as string,
      terminalCode: res.body.terminalCode as string,
      terminalId: terminal.id,
      body: res.body,
    };
  }

  // =========================================================================
  // Sign-in
  // =========================================================================

  it('signs in an owner and returns a pairing session; audits the event', async () => {
    const t = await seedOwnerTree();
    const res = await signIn(t.user.email).expect(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.email).toBe(t.user.email);
    expect(res.body.ownerName).toBe(t.owner.name);

    const audit = await raw.auditLog.findMany({
      where: { action: 'auth.pairing_signin', ownerId: t.owner.id },
    });
    expect(audit.length).toBe(1);
  });

  it('rejects a wrong password (401) and a suspended owner (403)', async () => {
    const t = await seedOwnerTree();
    await signIn(t.user.email, 'wrong').expect(401);

    const s = await seedOwnerTree({
      status: 'suspended',
      suspendedAt: new Date(),
    });
    await signIn(s.user.email).expect(403);
  });

  // =========================================================================
  // Businesses / branches (pairing token)
  // =========================================================================

  it('lists the owner businesses and branches under the pairing token', async () => {
    const t = await seedOwnerTree();
    const token = await pairToken(t);

    const biz = await request(server())
      .get('/v1/pos/pairing/businesses')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(biz.body.map((b: any) => b.id)).toContain(t.business.id);
    expect(biz.body[0]).toHaveProperty('type');
    expect(biz.body[0]).toHaveProperty('isDemo');

    const branches = await request(server())
      .get(`/v1/pos/pairing/businesses/${t.business.id}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(branches.body.map((b: any) => b.id)).toContain(t.branch.id);
  });

  it('rejects pairing routes without a pairing token (401)', async () => {
    await request(server()).get('/v1/pos/pairing/businesses').expect(401);
  });

  it('rejects a pairing token on an access-token route (no privilege escalation)', async () => {
    const t = await seedOwnerTree();
    const token = await pairToken(t);
    // A pairing token is signed with the access secret but carries aud:"pairing";
    // it must NOT authenticate a normal portal/admin route.
    await request(server())
      .get('/v1/portal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('does not expose another owner’s branches via the pairing token', async () => {
    const a = await seedOwnerTree();
    const b = await seedOwnerTree();
    const token = await pairToken(a);
    await request(server())
      .get(`/v1/pos/pairing/businesses/${b.business.id}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  // =========================================================================
  // Pair
  // =========================================================================

  it('pairs a terminal: T1, device token, receiptSeq 1, and a terminal.pair audit', async () => {
    const t = await seedOwnerTree();
    const { deviceToken, terminalCode, terminalId, body } = await pair(t);

    expect(terminalCode).toBe('T1');
    expect(body.receiptSeq).toBe(1);
    expect(body.business.id).toBe(t.business.id);
    expect(body.branch.id).toBe(t.branch.id);
    expect(deviceToken).toHaveLength(64); // 32 bytes hex

    // Stored as a hash, never the raw token.
    const term = await raw.terminal.findUniqueOrThrow({
      where: { id: terminalId },
    });
    expect(term.deviceTokenHash).toBe(sha256(deviceToken));

    const audit = await raw.auditLog.findMany({
      where: { action: 'terminal.pair', entityId: terminalId },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].actorType).toBe('owner');
  });

  it('re-pairs after unpair as T2 (codes never reused) with receiptSeq 1', async () => {
    const t = await seedOwnerTree();
    const first = await pair(t);
    // Portal/remote unpair: null the device token hash.
    await raw.terminal.update({
      where: { id: first.terminalId },
      data: { deviceTokenHash: null, deletedAt: new Date() },
    });

    const second = await pair(t);
    expect(second.terminalCode).toBe('T2');
    expect(second.body.receiptSeq).toBe(1);
  });

  // =========================================================================
  // TerminalGuard (via GET /v1/pos/session)
  // =========================================================================

  const session = (deviceToken: string) =>
    request(server())
      .get('/v1/pos/session')
      .set('Authorization', `Bearer ${deviceToken}`);

  it('accepts the device token on a guarded route and 401s once unpaired', async () => {
    const t = await seedOwnerTree();
    const { deviceToken, terminalId } = await pair(t);

    const ok = await session(deviceToken).expect(200);
    expect(ok.body.terminalCode).toBe('T1');
    expect(ok.body.branchId).toBe(t.branch.id);

    // Remote unpair (null the hash) → the next device request 401s.
    await raw.terminal.update({
      where: { id: terminalId },
      data: { deviceTokenHash: null },
    });
    await session(deviceToken).expect(401);
  });

  it('POS unpair nulls the hash + writes terminal.unpair, then the token 401s', async () => {
    const t = await seedOwnerTree();
    const { deviceToken, terminalId } = await pair(t);

    await request(server())
      .post('/v1/pos/unpair')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ email: t.user.email, password: PASSWORD })
      .expect(201);

    const term = await raw.terminal.findUniqueOrThrow({
      where: { id: terminalId },
    });
    expect(term.deviceTokenHash).toBeNull();

    const audit = await raw.auditLog.findMany({
      where: { action: 'terminal.unpair', entityId: terminalId },
    });
    expect(audit.length).toBe(1);

    await session(deviceToken).expect(401);
  });

  // =========================================================================
  // Suspension-aware guard
  // =========================================================================

  it('401s a hard-suspended owner’s terminal', async () => {
    const t = await seedOwnerTree();
    const { deviceToken } = await pair(t);
    await raw.owner.update({
      where: { id: t.owner.id },
      data: { status: 'hard_suspended', suspendedAt: new Date() },
    });
    await session(deviceToken).expect(401);
  });

  it('default-suspend: sells with an open shift, else 403 (audited); 403 past 24h', async () => {
    const t = await seedOwnerTree();
    const { deviceToken, terminalId } = await pair(t);

    // Default-suspend, within the 24h grace.
    await raw.owner.update({
      where: { id: t.owner.id },
      data: { status: 'suspended', suspendedAt: new Date() },
    });

    // No open shift → 403 owner_suspended (denial audited).
    const denied = await session(deviceToken).expect(403);
    expect(denied.body.code).toBe('owner_suspended');
    const denials = await waitForAudit({
      action: 'auth.denied.owner_suspended',
    });
    expect(denials.length).toBeGreaterThanOrEqual(1);

    // Open shift for this terminal → grace allows the sale to continue.
    await raw.shift.create({
      data: {
        branchId: t.branch.id,
        terminalId,
        openedAt: new Date(),
        openingCash: 0,
      },
    });
    await session(deviceToken).expect(200);

    // Past 24h → 403 even with an open shift.
    await raw.owner.update({
      where: { id: t.owner.id },
      data: { suspendedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    await session(deviceToken).expect(403);
  });
});
