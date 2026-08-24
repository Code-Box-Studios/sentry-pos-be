/*
 * Task 8 — TOTP 2FA e2e (TDD).
 *
 * Seeds platform_admin users via the raw client, drives the real Nest app over
 * HTTP with supertest, and covers the full TOTP enrollment + verification flow
 * plus all security boundary assertions.
 *
 * Dynamically-shaped seed rows and JSON metadata are inherently `any`-typed, so
 * the unsafe-* rules are disabled file-wide (pattern shared with other e2e specs).
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  INestApplication,
  ValidationPipe,
  HttpStatus,
  Controller,
  Get,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { generateSync } from 'otplib';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashSecret } from '../src/auth/hashing';
import { AdminGuard } from '../src/auth/guards/admin.guard';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();

async function seedAdmin(label: string) {
  const admin = await raw.user.create({
    data: {
      email: `totp-admin-${label}-${Date.now()}-${Math.random()}@test.com`,
      role: 'platform_admin',
      passwordHash: await hashSecret('adminpass123'),
      // totpSecret intentionally null → triggers totpSetupRequired
    },
  });
  return { admin };
}

/** A minimal controller used to test that AdminGuard rejects preauth tokens */
@Controller('test-admin-probe')
@UseGuards(AdminGuard)
class AdminProbeController {
  @Get()
  ping() {
    return { ok: true };
  }
}

describe('TOTP 2FA (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await raw.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [AdminProbeController],
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

  // =========================================================================
  // 1. New admin login → totpSetupRequired + preAuthToken, no accessToken
  // =========================================================================

  it('new admin login → totpSetupRequired + preAuthToken, no accessToken', async () => {
    const { admin } = await seedAdmin('new');
    const res = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);

    expect(res.body.totpSetupRequired).toBe(true);
    expect(res.body.preAuthToken).toBeDefined();
    expect(typeof res.body.preAuthToken).toBe('string');
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });

  // =========================================================================
  // 2. Full enrollment flow: setup → enable → recovery codes
  // =========================================================================

  it('setup returns otpauthUri + secret; enable with valid code returns 8 recovery codes', async () => {
    const { admin } = await seedAdmin('enroll');

    // Login → preAuthToken
    const loginRes = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken = loginRes.body.preAuthToken as string;

    // Setup: store pending secret
    const setupRes = await request(server())
      .post('/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${preAuthToken}`)
      .expect(201);

    expect(setupRes.body.otpauthUri).toBeDefined();
    expect(typeof setupRes.body.otpauthUri).toBe('string');
    expect(setupRes.body.secret).toBeDefined();
    const secret = setupRes.body.secret as string;

    // Generate a valid TOTP code from the returned secret using otplib 13 functional API
    const code = generateSync({ secret });

    // Enable: activate with the TOTP code
    const enableRes = await request(server())
      .post('/v1/auth/totp/enable')
      .set('Authorization', `Bearer ${preAuthToken}`)
      .send({ code })
      .expect(201);

    expect(enableRes.body.recoveryCodes).toBeDefined();
    expect(Array.isArray(enableRes.body.recoveryCodes)).toBe(true);
    expect(enableRes.body.recoveryCodes).toHaveLength(8);
    // All codes are non-empty strings
    for (const rc of enableRes.body.recoveryCodes as string[]) {
      expect(typeof rc).toBe('string');
      expect(rc.length).toBeGreaterThan(0);
    }
  });

  // =========================================================================
  // 3. After enrollment, next login → totpRequired (not setupRequired)
  // =========================================================================

  it('after enrollment, next login → totpRequired + preAuthToken', async () => {
    const { admin } = await seedAdmin('after-enroll');

    // Full enrollment
    const loginRes = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken = loginRes.body.preAuthToken as string;

    const setupRes = await request(server())
      .post('/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${preAuthToken}`)
      .expect(201);
    const secret = setupRes.body.secret as string;
    const code = generateSync({ secret });

    await request(server())
      .post('/v1/auth/totp/enable')
      .set('Authorization', `Bearer ${preAuthToken}`)
      .send({ code })
      .expect(201);

    // Second login
    const res2 = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);

    expect(res2.body.totpRequired).toBe(true);
    expect(res2.body.preAuthToken).toBeDefined();
    expect(res2.body.totpSetupRequired).toBeUndefined();
    expect(res2.body.accessToken).toBeUndefined();
  });

  // =========================================================================
  // 4. Verify with wrong TOTP code → 401 totp_invalid
  // =========================================================================

  it('verify with wrong TOTP code → 401 totp_invalid', async () => {
    const { admin } = await seedAdmin('wrong-code');

    // Enroll the admin
    const loginRes = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken1 = loginRes.body.preAuthToken as string;

    const setupRes = await request(server())
      .post('/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${preAuthToken1}`)
      .expect(201);
    const secret = setupRes.body.secret as string;
    const code = generateSync({ secret });

    await request(server())
      .post('/v1/auth/totp/enable')
      .set('Authorization', `Bearer ${preAuthToken1}`)
      .send({ code })
      .expect(201);

    // Second login → get preAuthToken for verify
    const loginRes2 = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken2 = loginRes2.body.preAuthToken as string;

    // Verify with wrong code
    const res = await request(server())
      .post('/v1/auth/totp/verify')
      .send({ preAuthToken: preAuthToken2, code: '000000' })
      .expect(401);

    expect(res.body.code).toBe('totp_invalid');
  });

  // =========================================================================
  // 5. Verify with correct TOTP code → full token pair
  // =========================================================================

  it('verify with correct TOTP code → full accessToken + refreshToken + role', async () => {
    const { admin } = await seedAdmin('correct-code');

    // Enroll
    const loginRes = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken1 = loginRes.body.preAuthToken as string;

    const setupRes = await request(server())
      .post('/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${preAuthToken1}`)
      .expect(201);
    const secret = setupRes.body.secret as string;
    const enableCode = generateSync({ secret });

    await request(server())
      .post('/v1/auth/totp/enable')
      .set('Authorization', `Bearer ${preAuthToken1}`)
      .send({ code: enableCode })
      .expect(201);

    // Second login
    const loginRes2 = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken2 = loginRes2.body.preAuthToken as string;

    // Generate fresh code for verify (same second is fine in test env)
    const verifyCode = generateSync({ secret });

    const res = await request(server())
      .post('/v1/auth/totp/verify')
      .send({ preAuthToken: preAuthToken2, code: verifyCode })
      .expect(201);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.role).toBe('platform_admin');
    expect(res.body.preAuthToken).toBeUndefined();
  });

  // =========================================================================
  // 6. Recovery code works exactly once; second use fails
  // =========================================================================

  it('recovery code works exactly once; second use → 401 totp_invalid', async () => {
    const { admin } = await seedAdmin('recovery');

    // Enroll
    const loginRes = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken1 = loginRes.body.preAuthToken as string;

    const setupRes = await request(server())
      .post('/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${preAuthToken1}`)
      .expect(201);
    const secret = setupRes.body.secret as string;
    const enableCode = generateSync({ secret });

    const enableRes = await request(server())
      .post('/v1/auth/totp/enable')
      .set('Authorization', `Bearer ${preAuthToken1}`)
      .send({ code: enableCode })
      .expect(201);
    const recoveryCodes: string[] = enableRes.body.recoveryCodes;
    const recoveryCode = recoveryCodes[0];

    // First use of recovery code — must succeed
    const loginRes2 = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken2 = loginRes2.body.preAuthToken as string;

    const res1 = await request(server())
      .post('/v1/auth/totp/verify')
      .send({ preAuthToken: preAuthToken2, code: recoveryCode })
      .expect(201);
    expect(res1.body.accessToken).toBeDefined();

    // Second use of the same recovery code — must fail
    const loginRes3 = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken3 = loginRes3.body.preAuthToken as string;

    const res2 = await request(server())
      .post('/v1/auth/totp/verify')
      .send({ preAuthToken: preAuthToken3, code: recoveryCode })
      .expect(401);
    expect(res2.body.code).toBe('totp_invalid');
  });

  // =========================================================================
  // 7. preAuthToken as Bearer on an AdminGuard-protected route → 401
  // =========================================================================

  it('preAuthToken as Bearer on an AdminGuard-protected route → 401', async () => {
    const { admin } = await seedAdmin('preauth-on-admin');

    const loginRes = await request(server())
      .post('/v1/auth/login')
      .send({ email: admin.email, password: 'adminpass123' })
      .expect(201);
    const preAuthToken = loginRes.body.preAuthToken as string;

    // AdminGuard must reject preauth tokens
    const res = await request(server())
      .get('/v1/test-admin-probe')
      .set('Authorization', `Bearer ${preAuthToken}`)
      .expect(401);

    expect(res.body.code).toBe('unauthorized');
  });

  // =========================================================================
  // 8. Access token presented to /totp/setup → 401
  // =========================================================================

  it('access token presented to /totp/setup → 401', async () => {
    // Seed an owner (not admin) to get a real access token
    const owner = await raw.owner.create({
      data: {
        name: 'Test Owner',
        email: `owner-access-probe-${Date.now()}@test.com`,
        status: 'active',
      },
    });
    const user = await raw.user.create({
      data: {
        email: `user-access-probe-${Date.now()}@test.com`,
        role: 'owner',
        ownerId: owner.id,
        passwordHash: await hashSecret('password123'),
      },
    });

    const loginRes = await request(server())
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'password123' })
      .expect(201);
    const accessToken = loginRes.body.accessToken as string;

    // Access token must be rejected by /totp/setup
    const res = await request(server())
      .post('/v1/auth/totp/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);

    expect(res.body.code).toBe('unauthorized');
  });

  // =========================================================================
  // 9. Access token passed as preAuthToken to /totp/verify → 401
  // =========================================================================

  it('access token passed as preAuthToken to /totp/verify → 401', async () => {
    // Get a real access token (owner)
    const owner = await raw.owner.create({
      data: {
        name: 'Test Owner2',
        email: `owner-verify-probe-${Date.now()}@test.com`,
        status: 'active',
      },
    });
    const user = await raw.user.create({
      data: {
        email: `user-verify-probe-${Date.now()}@test.com`,
        role: 'owner',
        ownerId: owner.id,
        passwordHash: await hashSecret('password123'),
      },
    });

    const loginRes = await request(server())
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'password123' })
      .expect(201);
    const accessToken = loginRes.body.accessToken as string;

    // Pass access token as preAuthToken in body
    const res = await request(server())
      .post('/v1/auth/totp/verify')
      .send({ preAuthToken: accessToken, code: '123456' })
      .expect(401);

    expect(res.body.code).toBe('unauthorized');
  });
});
