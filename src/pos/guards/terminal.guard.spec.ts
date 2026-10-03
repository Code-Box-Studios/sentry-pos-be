import { ExecutionContext } from '@nestjs/common';
import { TerminalGuard } from './terminal.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { UnauthorizedError } from '../../common/errors/api-errors';
import {
  getContext,
  requestContext,
} from '../../common/context/request-context';

describe('TerminalGuard ancestor deletion', () => {
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: 'Bearer device-token' } }),
    }),
  } as unknown as ExecutionContext;

  function fixture() {
    const owner = {
      id: 'owner',
      status: 'active',
      deletedAt: null as Date | null,
      suspendedAt: null as Date | null,
    };
    const business = { id: 'business', deletedAt: null as Date | null, owner };
    const branch = {
      id: 'branch',
      businessId: business.id,
      deletedAt: null as Date | null,
      business,
    };
    const terminal = {
      id: 'terminal',
      branchId: branch.id,
      code: 'T1',
      lastSeenAt: null,
      branch,
    };
    const raw = {
      terminal: {
        findFirst: jest.fn().mockResolvedValue(terminal),
        update: jest.fn().mockResolvedValue(terminal),
      },
      shift: { findFirst: jest.fn().mockResolvedValue({ id: 'open-shift' }) },
    };
    const guard = new TerminalGuard(raw as unknown as PrismaService);
    return { owner, business, branch, raw, guard };
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    return requestContext.run(
      {
        requestId: 'request',
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

  it.each(['owner', 'business', 'branch'] as const)(
    'revokes access when the %s is deleted and retains denial attribution',
    async (ancestor) => {
      const f = fixture();
      f[ancestor].deletedAt = new Date();
      // An open shift in the suspension grace period must not override deletion.
      f.owner.status = 'suspended';
      f.owner.suspendedAt = new Date();
      await run(async () => {
        await expect(f.guard.canActivate(context)).rejects.toBeInstanceOf(
          UnauthorizedError,
        );
        expect(getContext()).toMatchObject({
          actor: { type: 'terminal', id: 'terminal' },
          ownerId: 'owner',
          businessId: 'business',
          branchId: 'branch',
        });
      });
      expect(f.raw.terminal.update).not.toHaveBeenCalled();
      expect(f.raw.shift.findFirst).not.toHaveBeenCalled();
    },
  );

  it('allows a terminal with live ancestors and updates liveness', async () => {
    const f = fixture();
    await expect(run(() => f.guard.canActivate(context))).resolves.toBe(true);
    expect(f.raw.terminal.update).toHaveBeenCalledTimes(1);
  });
});
