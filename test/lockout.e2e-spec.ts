/**
 * LockoutService e2e tests — run under the e2e harness (global-setup + resetDb)
 * against the real Postgres DB on 54400.
 *
 * These tests assert against real `users` and `audit_logs` rows via the raw
 * PrismaClient, so they MUST live here and NOT under the unit test config.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { LockoutService } from '../src/common/lockout/lockout.service';
import { hashSecret } from '../src/auth/hashing';
import {
  PinLockedError,
  PinInvalidError,
  LoginLockedError,
  LoginInvalidError,
  ValidationFailedError,
} from '../src/common/errors/api-errors';
import { resetDb, closeDb } from './helpers/db';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const raw = new PrismaClient() as unknown as PrismaService;
const lockout = new LockoutService(raw);

async function seedOwnerAndUser(label: string, pinHash?: string) {
  const owner = await (raw as unknown as PrismaClient).owner.create({
    data: {
      name: `Owner ${label}`,
      email: `owner-${label}-${Date.now()}@test.com`,
    },
  });
  const user = await (raw as unknown as PrismaClient).user.create({
    data: {
      email: `user-${label}-${Date.now()}@test.com`,
      role: 'owner',
      ownerId: owner.id,
      pinHash: pinHash ?? null,
      failedPinCount: 0,
      failedLoginCount: 0,
    },
  });
  return { owner, user };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LockoutService (e2e)', () => {
  beforeAll(async () => {
    await (raw as unknown as PrismaClient).$connect();
  });

  afterAll(async () => {
    await (raw as unknown as PrismaClient).$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  // =========================================================================
  // 4-strike sequence for PIN
  // =========================================================================

  it('records 4 PIN failures with attemptsRemaining 3,2,1,0 then locks', async () => {
    const { user } = await seedOwnerAndUser('pin-seq');

    const getUserFresh = () =>
      (raw as unknown as PrismaClient).user.findUniqueOrThrow({
        where: { id: user.id },
      });

    // Attempt 1 → attemptsRemaining: 3
    let err = await lockout.recordFailure(user.id, 'pin').catch((e) => e);
    expect(err).toBeInstanceOf(PinInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(3);
    let fresh = await getUserFresh();
    expect(fresh.failedPinCount).toBe(1);
    expect(fresh.pinLockedUntil).toBeNull();

    // Attempt 2 → attemptsRemaining: 2
    err = await lockout.recordFailure(user.id, 'pin').catch((e) => e);
    expect(err).toBeInstanceOf(PinInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(2);
    fresh = await getUserFresh();
    expect(fresh.failedPinCount).toBe(2);
    expect(fresh.pinLockedUntil).toBeNull();

    // Attempt 3 → attemptsRemaining: 1
    err = await lockout.recordFailure(user.id, 'pin').catch((e) => e);
    expect(err).toBeInstanceOf(PinInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(1);
    fresh = await getUserFresh();
    expect(fresh.failedPinCount).toBe(3);
    expect(fresh.pinLockedUntil).toBeNull();

    // Attempt 4 → attemptsRemaining: 0, NOW LOCKED
    err = await lockout.recordFailure(user.id, 'pin').catch((e) => e);
    expect(err).toBeInstanceOf(PinInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(0);
    fresh = await getUserFresh();
    expect(fresh.failedPinCount).toBe(4);
    expect(fresh.pinLockedUntil).not.toBeNull();
    expect(fresh.pinLockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  // =========================================================================
  // 4-strike sequence for LOGIN
  // =========================================================================

  it('records 4 login failures with attemptsRemaining 3,2,1,0 then locks', async () => {
    const { user } = await seedOwnerAndUser('login-seq');

    const getUserFresh = () =>
      (raw as unknown as PrismaClient).user.findUniqueOrThrow({
        where: { id: user.id },
      });

    // Attempt 1 → attemptsRemaining: 3
    let err = await lockout.recordFailure(user.id, 'login').catch((e) => e);
    expect(err).toBeInstanceOf(LoginInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(3);

    // Attempt 2 → attemptsRemaining: 2
    err = await lockout.recordFailure(user.id, 'login').catch((e) => e);
    expect(err).toBeInstanceOf(LoginInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(2);

    // Attempt 3 → attemptsRemaining: 1
    err = await lockout.recordFailure(user.id, 'login').catch((e) => e);
    expect(err).toBeInstanceOf(LoginInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(1);

    // Attempt 4 → attemptsRemaining: 0, NOW LOCKED
    err = await lockout.recordFailure(user.id, 'login').catch((e) => e);
    expect(err).toBeInstanceOf(LoginInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(0);
    const fresh = await getUserFresh();
    expect(fresh.failedLoginCount).toBe(4);
    expect(fresh.loginLockedUntil).not.toBeNull();
  });

  // =========================================================================
  // assertNotLocked — locked short-circuit
  // =========================================================================

  it('assertNotLocked throws PinLockedError when locked_until is in the future', async () => {
    const { user } = await seedOwnerAndUser('locked-pin');

    // Manually set a future lock
    const future = new Date(Date.now() + 60_000); // 60s from now
    const lockedUser = await (raw as unknown as PrismaClient).user.update({
      where: { id: user.id },
      data: { pinLockedUntil: future },
    });

    expect(() => lockout.assertNotLocked(lockedUser, 'pin')).toThrow(
      PinLockedError,
    );

    // retryAfterSeconds should be between 1 and 60
    let caughtErr: PinLockedError | undefined;
    try {
      lockout.assertNotLocked(lockedUser, 'pin');
    } catch (e) {
      caughtErr = e as PinLockedError;
    }
    const resp = caughtErr!.getResponse() as any;
    expect(resp.retryAfterSeconds).toBeGreaterThan(0);
    expect(resp.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('assertNotLocked throws LoginLockedError when login locked_until is in the future', async () => {
    const { user } = await seedOwnerAndUser('locked-login');
    const future = new Date(Date.now() + 60_000);
    const lockedUser = await (raw as unknown as PrismaClient).user.update({
      where: { id: user.id },
      data: { loginLockedUntil: future },
    });

    expect(() => lockout.assertNotLocked(lockedUser, 'login')).toThrow(
      LoginLockedError,
    );
  });

  it('assertNotLocked does NOT throw when locked_until is in the past', async () => {
    const { user } = await seedOwnerAndUser('expired-pin');
    const past = new Date(Date.now() - 1_000); // 1s ago
    const expiredUser = await (raw as unknown as PrismaClient).user.update({
      where: { id: user.id },
      data: { pinLockedUntil: past },
    });

    // Should not throw
    expect(() => lockout.assertNotLocked(expiredUser, 'pin')).not.toThrow();
  });

  // =========================================================================
  // Post-expiry re-lock
  // =========================================================================

  it('post-expiry re-lock: after lockout expires, one more failure re-locks immediately with attemptsRemaining=0', async () => {
    const { user } = await seedOwnerAndUser('relock');

    // Simulate an elapsed lockout: set count=4 and locked_until=past
    const past = new Date(Date.now() - 1_000); // 1s ago — lock has expired
    await (raw as unknown as PrismaClient).user.update({
      where: { id: user.id },
      data: { failedPinCount: 4, pinLockedUntil: past },
    });

    // One more failure with count already at 4 → new count = 5, still >= 4 → re-lock
    const err = await lockout.recordFailure(user.id, 'pin').catch((e) => e);
    expect(err).toBeInstanceOf(PinInvalidError);
    expect(err.getResponse().attemptsRemaining).toBe(0); // max(0, 4-5) = 0

    const fresh = await (raw as unknown as PrismaClient).user.findUniqueOrThrow(
      {
        where: { id: user.id },
      },
    );
    expect(fresh.failedPinCount).toBe(5);
    expect(fresh.pinLockedUntil).not.toBeNull();
    expect(fresh.pinLockedUntil!.getTime()).toBeGreaterThan(Date.now()); // re-locked in future
  });

  // =========================================================================
  // recordSuccess resets counters
  // =========================================================================

  it('recordSuccess resets PIN counter and lock', async () => {
    const { user } = await seedOwnerAndUser('reset-pin');

    // Accumulate some failures
    await lockout.recordFailure(user.id, 'pin').catch(() => {});
    await lockout.recordFailure(user.id, 'pin').catch(() => {});

    await lockout.recordSuccess(user.id, 'pin');

    const fresh = await (raw as unknown as PrismaClient).user.findUniqueOrThrow(
      {
        where: { id: user.id },
      },
    );
    expect(fresh.failedPinCount).toBe(0);
    expect(fresh.pinLockedUntil).toBeNull();
  });

  it('recordSuccess resets login counter and lock', async () => {
    const { user } = await seedOwnerAndUser('reset-login');

    // Set a future lock manually
    await (raw as unknown as PrismaClient).user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 4,
        loginLockedUntil: new Date(Date.now() + 60_000),
      },
    });

    await lockout.recordSuccess(user.id, 'login');

    const fresh = await (raw as unknown as PrismaClient).user.findUniqueOrThrow(
      {
        where: { id: user.id },
      },
    );
    expect(fresh.failedLoginCount).toBe(0);
    expect(fresh.loginLockedUntil).toBeNull();
  });

  // =========================================================================
  // verifyPinWithLockout — audit row on PIN failure
  // =========================================================================

  it('verifyPinWithLockout writes an audit row with attempted identity on PIN failure', async () => {
    const pinPlain = '1234';
    const pinHash = await hashSecret(pinPlain);
    const { owner, user } = await seedOwnerAndUser('audit-pin', pinHash);

    // Attempt with wrong PIN
    await expect(
      lockout.verifyPinWithLockout(owner.id, 'wrong-pin'),
    ).rejects.toBeInstanceOf(PinInvalidError);

    // Assert audit row exists
    const logs = await (raw as unknown as PrismaClient).auditLog.findMany({
      where: { action: 'auth.pin_failure', entityId: user.id },
    });
    expect(logs).toHaveLength(1);
    const meta = logs[0].metadata as any;
    // The attempted identity is recorded in metadata
    expect(meta.attemptedBy).toBe(user.id);
    expect(logs[0].ownerId).toBe(owner.id);
    expect(logs[0].entityType).toBe('user');
  });

  it('verifyPinWithLockout succeeds and resets counter when PIN matches', async () => {
    const pinPlain = '9876';
    const pinHash = await hashSecret(pinPlain);
    const { owner, user } = await seedOwnerAndUser('correct-pin', pinHash);

    // Pre-load a failed attempt
    await lockout.recordFailure(user.id, 'pin').catch(() => {});

    // Correct PIN → no throw, counter reset
    await expect(
      lockout.verifyPinWithLockout(owner.id, pinPlain),
    ).resolves.toBeUndefined();

    const fresh = await (raw as unknown as PrismaClient).user.findUniqueOrThrow(
      {
        where: { id: user.id },
      },
    );
    expect(fresh.failedPinCount).toBe(0);
    expect(fresh.pinLockedUntil).toBeNull();
  });

  it('verifyPinWithLockout throws ValidationFailedError with the exact message when no PIN is set', async () => {
    const { owner } = await seedOwnerAndUser('no-pin'); // pinHash=null

    const err = await lockout
      .verifyPinWithLockout(owner.id, '1234')
      .catch((e) => e);

    expect(err).toBeInstanceOf(ValidationFailedError);
    // Pin the exact-message contract: a refactor must not silently change it.
    expect((err as ValidationFailedError).message).toBe(
      'set the refund PIN in the portal',
    );
    const resp = err.getResponse() as { code: string; message: string };
    expect(resp.code).toBe('validation');
    expect(resp.message).toBe('set the refund PIN in the portal');
  });

  it('verifyPinWithLockout short-circuits at assertNotLocked when locked', async () => {
    const pinPlain = '1111';
    const pinHash = await hashSecret(pinPlain);
    const { owner, user } = await seedOwnerAndUser('locked-check', pinHash);

    // Force a lock
    await (raw as unknown as PrismaClient).user.update({
      where: { id: user.id },
      data: { pinLockedUntil: new Date(Date.now() + 60_000) },
    });

    await expect(
      lockout.verifyPinWithLockout(owner.id, pinPlain),
    ).rejects.toBeInstanceOf(PinLockedError);

    // No audit row should be written (short-circuited before verification)
    const logs = await (raw as unknown as PrismaClient).auditLog.findMany({
      where: { action: 'auth.pin_failure', entityId: user.id },
    });
    expect(logs).toHaveLength(0);
  });
});
