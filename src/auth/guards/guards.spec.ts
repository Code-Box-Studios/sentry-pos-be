/*
 * Unit specs for the auth guards + JWT strategy. These assert the
 * security-critical behaviors that the e2e suite cannot easily reach without a
 * protected route: preauth rejection, garbage/expired token rejection, the
 * owner-status gate, and the platform-admin role gate. We drive the guards with
 * a hand-built ExecutionContext and a fake passport pipeline.
 */

/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from '../jwt.strategy';
import { PortalAuthGuard } from './portal-auth.guard';
import { AdminGuard } from './admin.guard';
import {
  UnauthorizedError,
  ForbiddenError,
  OwnerSuspendedError,
} from '../../common/errors/api-errors';
import {
  requestContext,
  getContext,
} from '../../common/context/request-context';

const ACCESS_SECRET = 'test-access-secret-change-me';

function ctxWith(headers: Record<string, string>): ExecutionContext {
  const req: any = { headers, user: undefined };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function runInCtx<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run(
    {
      requestId: 'r',
      scope: null,
      actor: null,
      ownerId: null,
      businessId: null,
      branchId: null,
      terminalCode: null,
      sessionId: null,
      ip: '127.0.0.1',
      userAgent: 'jest',
      deviceTimestamp: null,
    },
    fn,
  );
}

describe('JwtStrategy', () => {
  const config = { getOrThrow: () => ACCESS_SECRET } as any;
  const strategy = new JwtStrategy(config);

  it('rejects a preauth token', () => {
    expect(() =>
      strategy.validate({
        sub: 'u1',
        role: 'platform_admin',
        sid: 's',
        kind: 'preauth',
      }),
    ).toThrow(UnauthorizedError);
  });

  it('accepts a normal access token payload', () => {
    const p = strategy.validate({ sub: 'u1', role: 'owner', sid: 's' });
    expect(p.sub).toBe('u1');
  });
});

describe('PortalAuthGuard', () => {
  const jwt = new JwtService({});
  const sign = (payload: object, expiresIn = '15m') =>
    jwt.sign(payload, { secret: ACCESS_SECRET, expiresIn });

  function guardWithUser(user: any, owner: any = null) {
    const raw: any = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      owner: { findUnique: jest.fn().mockResolvedValue(owner) },
    };
    return new PortalAuthGuard(raw);
  }

  it('rejects a garbage token with 401', async () => {
    const guard = guardWithUser(null);
    await runInCtx(async () => {
      await expect(
        guard.canActivate(
          ctxWith({ authorization: 'Bearer garbage.token.here' }),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('rejects a missing Authorization header with 401', async () => {
    const guard = guardWithUser(null);
    await runInCtx(async () => {
      await expect(guard.canActivate(ctxWith({}))).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });

  it('rejects an expired token with 401', async () => {
    const guard = guardWithUser({ id: 'u1', ownerId: 'o1', deletedAt: null });
    const token = sign({ sub: 'u1', role: 'owner', sid: 's1' }, '-1s');
    await runInCtx(async () => {
      await expect(
        guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('rejects a preauth token with 401', async () => {
    const guard = guardWithUser({ id: 'u1', ownerId: 'o1', deletedAt: null });
    const token = sign({ sub: 'u1', kind: 'preauth', sid: 's1' });
    await runInCtx(async () => {
      await expect(
        guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('rejects a suspended owner with owner_suspended', async () => {
    const guard = guardWithUser(
      { id: 'u1', ownerId: 'o1', deletedAt: null },
      { id: 'o1', status: 'suspended' },
    );
    const token = sign({ sub: 'u1', role: 'owner', ownerId: 'o1', sid: 's1' });
    await runInCtx(async () => {
      await expect(
        guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
      ).rejects.toBeInstanceOf(OwnerSuspendedError);
    });
  });

  it('fails closed when the owner row is missing (dangling ownerId)', async () => {
    // user.ownerId is set but no owner row exists → must be denied, never granted.
    const guard = guardWithUser(
      { id: 'u1', ownerId: 'o-missing', deletedAt: null },
      null,
    );
    const token = sign({
      sub: 'u1',
      role: 'owner',
      ownerId: 'o-missing',
      sid: 's1',
    });
    await runInCtx(async () => {
      await expect(
        guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
      ).rejects.toBeInstanceOf(OwnerSuspendedError);
    });
  });

  it('accepts a live owner and stamps tenant context', async () => {
    const guard = guardWithUser(
      { id: 'u1', ownerId: 'o1', deletedAt: null },
      { id: 'o1', status: 'active' },
    );
    const token = sign({ sub: 'u1', role: 'owner', ownerId: 'o1', sid: 's1' });
    await runInCtx(async () => {
      const ok = await guard.canActivate(
        ctxWith({ authorization: `Bearer ${token}` }),
      );
      expect(ok).toBe(true);
      const stored = getContext();
      expect(stored.scope).toBe('tenant');
      expect(stored.actor).toEqual({ type: 'owner', id: 'u1' });
      expect(stored.ownerId).toBe('o1');
      expect(stored.sessionId).toBe('s1');
    });
  });
});

describe('AdminGuard', () => {
  const jwt = new JwtService({});
  const sign = (payload: object, expiresIn = '15m') =>
    jwt.sign(payload, { secret: ACCESS_SECRET, expiresIn });
  const guard = new AdminGuard();

  it('rejects a non-admin role with forbidden', async () => {
    const token = sign({ sub: 'u1', role: 'owner', sid: 's1' });
    await runInCtx(async () => {
      await expect(
        guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('rejects a preauth token with 401', async () => {
    const token = sign({ sub: 'u1', kind: 'preauth', sid: 's1' });
    await runInCtx(async () => {
      await expect(
        guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  it('accepts a platform_admin and stamps platform context', async () => {
    const token = sign({ sub: 'a1', role: 'platform_admin', sid: 's1' });
    await runInCtx(async () => {
      const ok = await guard.canActivate(
        ctxWith({ authorization: `Bearer ${token}` }),
      );
      expect(ok).toBe(true);
      const stored = getContext();
      expect(stored.scope).toBe('platform');
      expect(stored.actor).toEqual({ type: 'platform_admin', id: 'a1' });
      expect(stored.sessionId).toBe('s1');
    });
  });
});
