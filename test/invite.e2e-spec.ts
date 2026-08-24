/*
 * Task 9 — Mail + invite + password-reset + demo-business seed (TDD e2e).
 *
 * Drives the real Nest app over HTTP with supertest. Invite tokens are minted
 * through the app's InviteService.createInvite (the same path Task 10's admin
 * endpoint will call) so the raw-token / sha256-at-rest contract is exercised
 * end to end. Single-use / expiry edge cases seed auth_tokens rows directly.
 *
 * Dynamically-shaped seed rows and JSON metadata are inherently `any`-typed, so
 * the unsafe-* rules are disabled file-wide (pattern shared with other e2e specs).
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

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
import { InviteService } from '../src/auth/invite.service';
import { MailService } from '../src/mail/mail.service';
import { hashSecret } from '../src/auth/hashing';
import * as demoSeed from '../src/portal/demo-seed';
import { resetDb, closeDb } from './helpers/db';

const raw = new PrismaClient();

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

let seq = 0;
async function seedPendingOwner(status: string = 'suspended') {
  seq += 1;
  const owner = await raw.owner.create({
    data: {
      name: `Owner ${seq}`,
      email: `owner-${seq}-${Date.now()}@test.com`,
      status: status as any,
    },
  });
  const user = await raw.user.create({
    data: {
      email: `user-${seq}-${Date.now()}@test.com`,
      role: 'owner',
      ownerId: owner.id,
      passwordHash: null, // pre-activation
    },
  });
  return { owner, user };
}

describe('Invite + reset + demo seed (e2e)', () => {
  let app: INestApplication;
  let invites: InviteService;
  let mail: MailService;

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
    invites = app.get(InviteService);
    mail = app.get(MailService);
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
  // Invite accept — happy path: sets password, activates owner, login works
  // =========================================================================

  it('invite accept sets the password and the user can then log in', async () => {
    const { user } = await seedPendingOwner();

    const token = await invites.createInvite(user.id);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url

    // A mail was queued and its body carries the raw token (not the hash).
    expect(mail.sentMailbox.length).toBe(1);
    expect(mail.sentMailbox[0].html).toContain(token);

    await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token, password: 'newpassword123' })
      .expect(201);

    // Login with the new password now works.
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'newpassword123' })
      .expect(201);
    expect(login.body.accessToken).toBeDefined();
    expect(login.body.role).toBe('owner');
  });

  it('invite accept activates the owner (status → active)', async () => {
    const { owner, user } = await seedPendingOwner('suspended');
    const token = await invites.createInvite(user.id);

    await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token, password: 'newpassword123' })
      .expect(201);

    const after = await raw.owner.findUniqueOrThrow({
      where: { id: owner.id },
    });
    expect(after.status).toBe('active');
  });

  // =========================================================================
  // Invite token is single-use
  // =========================================================================

  it('invite token is single-use: a second accept fails', async () => {
    const { user } = await seedPendingOwner();
    const token = await invites.createInvite(user.id);

    await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token, password: 'newpassword123' })
      .expect(201);

    const second = await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token, password: 'anotherpass456' })
      .expect(400);
    expect(second.body.code).toBe('invalid_token');
  });

  // =========================================================================
  // Invite token expiry
  // =========================================================================

  it('expired invite token is rejected', async () => {
    const { user } = await seedPendingOwner();
    const rawToken = 'expired-invite-token-value-xyz';
    await raw.authToken.create({
      data: {
        kind: 'invite',
        tokenHash: sha256(rawToken),
        userId: user.id,
        expiresAt: new Date(Date.now() - 60_000), // already expired
      },
    });

    const res = await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token: rawToken, password: 'newpassword123' })
      .expect(400);
    expect(res.body.code).toBe('invalid_token');

    // Password must NOT have been set.
    const after = await raw.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBeNull();
  });

  it('unknown invite token is rejected', async () => {
    const res = await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token: 'totally-unknown-token', password: 'newpassword123' })
      .expect(400);
    expect(res.body.code).toBe('invalid_token');
  });

  // =========================================================================
  // Invite tokens are sha256-at-rest (never stored raw)
  // =========================================================================

  it('invite token is stored as a sha256 hash, never in the clear', async () => {
    const { user } = await seedPendingOwner();
    const token = await invites.createInvite(user.id);

    const rows = await raw.authToken.findMany({ where: { userId: user.id } });
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('invite');
    expect(rows[0].tokenHash).toBe(sha256(token));
    expect(rows[0].tokenHash).not.toBe(token);
    // 7-day expiry (allow generous slack for test runtime).
    const days = (rows[0].expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  // =========================================================================
  // Demo business seeding on accept
  // =========================================================================

  it('accepting an invite seeds the demo business with isDemo=true and its products', async () => {
    const { owner, user } = await seedPendingOwner();
    const token = await invites.createInvite(user.id);

    await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token, password: 'newpassword123' })
      .expect(201);

    const biz = await raw.business.findFirst({
      where: { ownerId: owner.id, isDemo: true },
    });
    expect(biz).not.toBeNull();
    expect(biz!.name).toBe('Kape Diaria (Demo)');
    expect(biz!.isDemo).toBe(true);

    // Catalog replicated faithfully from the FE mock seed.
    const categories = await raw.category.findMany({
      where: { businessId: biz!.id },
    });
    expect(categories.map((c) => c.name).sort()).toEqual(
      ['Bakery', 'Coffee', 'Grocery', 'Meals'].sort(),
    );

    const products = await raw.product.findMany({
      where: { businessId: biz!.id },
    });
    expect(products.length).toBe(12);

    const espresso = products.find((p) => p.sku === 'CF-101');
    expect(espresso).toBeDefined();
    expect(espresso!.name).toBe('Espresso');
    expect(espresso!.price).toBe(8500); // pesos(85)
    expect(espresso!.trackStock).toBe(false);

    const latte = products.find((p) => p.sku === 'CF-102');
    expect(latte).toBeDefined();
    const variants = await raw.productVariant.findMany({
      where: { productId: latte!.id },
    });
    expect(variants.length).toBe(3);
    expect(variants.map((v) => v.price).sort((a, b) => a - b)).toEqual([
      12000, 13000, 14500,
    ]);

    // Modifier groups + modifiers.
    const groups = await raw.modifierGroup.findMany({
      where: { businessId: biz!.id },
      include: { modifiers: true },
    });
    expect(groups.map((g) => g.name).sort()).toEqual(['Add-ons', 'Milk']);
    const milk = groups.find((g) => g.name === 'Milk')!;
    expect(milk.modifiers.length).toBe(2);
    const oat = milk.modifiers.find((m) => m.name === 'Oat milk')!;
    expect(oat.priceDelta).toBe(2500); // pesos(25)

    // Discounts.
    const discounts = await raw.discount.findMany({
      where: { businessId: biz!.id },
    });
    expect(discounts.length).toBe(3);
    const twentyOff = discounts.find((d) => d.name === '₱20 off')!;
    expect(twentyOff.kind).toBe('fixed');
    expect(twentyOff.value).toBe(2000); // pesos(20)

    // Branch + stock.
    const branch = await raw.branch.findFirst({
      where: { businessId: biz!.id },
    });
    expect(branch).not.toBeNull();
    const ubeloaf = products.find((p) => p.sku === 'BK-104')!;
    const ubeStock = await raw.branchStock.findFirst({
      where: { branchId: branch!.id, productId: ubeloaf.id },
    });
    expect(Number(ubeStock!.qty)).toBe(0); // out of stock in the mock
    const riceProd = products.find((p) => p.sku === 'GR-202')!;
    const riceStock = await raw.branchStock.findFirst({
      where: { branchId: branch!.id, productId: riceProd.id },
    });
    expect(Number(riceStock!.qty)).toBe(23.45);

    // One summary audit row business.demo_seeded, actor = the owner.
    const audit = await raw.auditLog.findMany({
      where: { action: 'business.demo_seeded' },
    });
    expect(audit.length).toBe(1);
    expect(audit[0].ownerId).toBe(owner.id);
    expect(audit[0].businessId).toBe(biz!.id);

    // §11 auth event: invite acceptance, actor = the owner.
    const accepted = await raw.auditLog.findMany({
      where: { action: 'auth.invite_accepted', entityId: user.id },
    });
    expect(accepted.length).toBe(1);
    expect(accepted[0].ownerId).toBe(owner.id);
  });

  // =========================================================================
  // Invite accept is ATOMIC — a seed failure rolls back the whole accept
  // =========================================================================

  it('a demo-seed failure rolls back the ENTIRE accept (token unconsumed, owner inactive, no partial rows)', async () => {
    const { owner, user } = await seedPendingOwner('suspended');
    const token = await invites.createInvite(user.id);

    // Force the demo seed to blow up part-way through the accept transaction.
    const spy = jest
      .spyOn(demoSeed, 'seedDemoBusiness')
      .mockRejectedValueOnce(new Error('injected seed failure'));

    // The accept surfaces the failure (mapped to 500 by the global filter).
    await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token, password: 'newpassword123' })
      .expect(500);

    spy.mockRestore();

    // Nothing was committed: token still unconsumed...
    const tokenRow = await raw.authToken.findUniqueOrThrow({
      where: { tokenHash: sha256(token) },
    });
    expect(tokenRow.usedAt).toBeNull();

    // ...password still unset, owner still inactive...
    const afterUser = await raw.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(afterUser.passwordHash).toBeNull();
    const afterOwner = await raw.owner.findUniqueOrThrow({
      where: { id: owner.id },
    });
    expect(afterOwner.status).toBe('suspended');

    // ...and no partial business/audit rows leaked.
    const biz = await raw.business.findFirst({ where: { ownerId: owner.id } });
    expect(biz).toBeNull();
    const seededAudit = await raw.auditLog.findMany({
      where: { action: 'business.demo_seeded' },
    });
    expect(seededAudit.length).toBe(0);
    const acceptedAudit = await raw.auditLog.findMany({
      where: { action: 'auth.invite_accepted' },
    });
    expect(acceptedAudit.length).toBe(0);

    // The invite can simply be RETRIED and now succeeds end to end.
    await request(server())
      .post('/v1/auth/invite/accept')
      .send({ token, password: 'newpassword123' })
      .expect(201);
    const retriedOwner = await raw.owner.findUniqueOrThrow({
      where: { id: owner.id },
    });
    expect(retriedOwner.status).toBe('active');
    const retriedBiz = await raw.business.findFirst({
      where: { ownerId: owner.id, isDemo: true },
    });
    expect(retriedBiz).not.toBeNull();
  });

  // =========================================================================
  // Password reset — request always 204 (no enumeration)
  // =========================================================================

  it('password-reset request for a known email returns 204 and queues mail', async () => {
    const { user } = await seedPendingOwner('active');
    // Give them a usable password so they are a "real" activated account.
    await raw.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashSecret('oldpassword123') },
    });

    await request(server())
      .post('/v1/auth/password-reset/request')
      .send({ email: user.email })
      .expect(204);

    // A reset mail was queued with a raw token in the body.
    expect(mail.sentMailbox.length).toBe(1);
    const rows = await raw.authToken.findMany({
      where: { userId: user.id, kind: 'reset' },
    });
    expect(rows.length).toBe(1);
    // 1-hour expiry.
    const mins = (rows[0].expiresAt.getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(58);
    expect(mins).toBeLessThan(62);
  });

  it('password-reset request for an UNKNOWN email still returns 204 (no enumeration)', async () => {
    await request(server())
      .post('/v1/auth/password-reset/request')
      .send({ email: 'nobody-here@nowhere.test' })
      .expect(204);

    // No mail sent, no token created.
    expect(mail.sentMailbox.length).toBe(0);
    const rows = await raw.authToken.findMany({ where: { kind: 'reset' } });
    expect(rows.length).toBe(0);
  });

  // =========================================================================
  // Password reset — confirm round-trips + revokes ALL refresh tokens
  // =========================================================================

  it('password-reset confirm sets the new password and old refresh tokens are revoked', async () => {
    const { user } = await seedPendingOwner('active');
    await raw.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashSecret('oldpassword123') },
    });

    // Establish two live sessions.
    const s1 = await request(server())
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'oldpassword123' })
      .expect(201);
    const s2 = await request(server())
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'oldpassword123' })
      .expect(201);

    // Request a reset, then read the raw token from the mailbox.
    await request(server())
      .post('/v1/auth/password-reset/request')
      .send({ email: user.email })
      .expect(204);
    const html = mail.sentMailbox[0].html;
    const match = /token=([A-Za-z0-9\-_]+)/.exec(html);
    expect(match).not.toBeNull();
    const resetToken = match![1];

    await request(server())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: resetToken, password: 'brandnewpass789' })
      .expect(204);

    // New password works.
    await request(server())
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'brandnewpass789' })
      .expect(201);

    // Old password fails.
    await request(server())
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'oldpassword123' })
      .expect(401);

    // Both pre-existing refresh tokens are now dead.
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: s1.body.refreshToken })
      .expect(401);
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: s2.body.refreshToken })
      .expect(401);

    // §11 auth event: password reset, actor = the user.
    const resetAudit = await raw.auditLog.findMany({
      where: { action: 'auth.password_reset', entityId: user.id },
    });
    expect(resetAudit.length).toBe(1);
  });

  it('reset confirm with an unknown token is rejected and single-use is enforced', async () => {
    const { user } = await seedPendingOwner('active');
    await raw.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashSecret('oldpassword123') },
    });

    // Unknown token.
    const bad = await request(server())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: 'nope-not-real', password: 'brandnewpass789' })
      .expect(400);
    expect(bad.body.code).toBe('invalid_token');

    // Real token, used once...
    await request(server())
      .post('/v1/auth/password-reset/request')
      .send({ email: user.email })
      .expect(204);
    const html = mail.sentMailbox[0].html;
    const resetToken = /token=([A-Za-z0-9\-_]+)/.exec(html)![1];

    await request(server())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: resetToken, password: 'brandnewpass789' })
      .expect(204);

    // ...cannot be reused.
    const reuse = await request(server())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: resetToken, password: 'yetanother000' })
      .expect(400);
    expect(reuse.body.code).toBe('invalid_token');
  });
});
