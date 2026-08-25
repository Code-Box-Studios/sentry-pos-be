import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  UnauthorizedError,
  OwnerSuspendedError,
} from '../../common/errors/api-errors';
import { setAuthContext } from '../../common/context/request-context';

const LAST_SEEN_THROTTLE_MS = 60_000;
/** §8 default-suspend grace window: open shifts may keep selling ≤ 24h. */
const SUSPEND_GRACE_MS = 24 * 60 * 60 * 1000;

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Task 16 — guards every `/pos/*` route (except pairing + unpair). Resolves the
 * `Authorization: Bearer <deviceToken>` to a terminal by sha256 hash; a miss is
 * 401 (this is what a remote unpair produces). Owner-status gate (§8):
 * hard_suspended/closed → 401; suspended → allowed ONLY while an open shift
 * exists for this terminal AND `suspendedAt` < 24h ago, else 403 `owner_suspended`
 * (an audited denial). Bumps `lastSeenAt` at most once per 60s (raw, unaudited
 * liveness), then stamps the terminal's tenant scope onto the RequestContext.
 */
@Injectable()
export class TerminalGuard implements CanActivate {
  constructor(private readonly raw: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: { authorization?: string } }>();

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedError();

    const deviceTokenHash = sha256(authHeader.slice(7));
    const terminal = await this.raw.terminal.findFirst({
      where: { deviceTokenHash, deletedAt: null },
      include: {
        branch: { include: { business: { include: { owner: true } } } },
      },
    });
    if (!terminal) throw new UnauthorizedError();

    const owner = terminal.branch.business.owner;

    // Stamp scope BEFORE the status gate so a denial is attributable to the
    // terminal/owner in the audit log.
    setAuthContext({
      scope: 'tenant',
      actor: { type: 'terminal', id: terminal.id },
      ownerId: owner.id,
      businessId: terminal.branch.businessId,
      branchId: terminal.branchId,
      terminalCode: terminal.code,
      sessionId: deviceTokenHash.slice(0, 8),
    });

    // Owner-status gate (§8).
    if (owner.status === 'hard_suspended' || owner.status === 'closed') {
      throw new UnauthorizedError();
    }
    if (owner.status === 'suspended') {
      const withinGrace =
        owner.suspendedAt != null &&
        Date.now() - owner.suspendedAt.getTime() < SUSPEND_GRACE_MS;
      const openShift = withinGrace
        ? await this.raw.shift.findFirst({
            where: { terminalId: terminal.id, closedAt: null, deletedAt: null },
            select: { id: true },
          })
        : null;
      if (!withinGrace || !openShift) {
        throw new OwnerSuspendedError();
      }
    }

    // Liveness timestamp — throttled, on the raw client, deliberately unaudited.
    const now = Date.now();
    if (
      !terminal.lastSeenAt ||
      now - terminal.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS
    ) {
      await this.raw.terminal.update({
        where: { id: terminal.id },
        data: { lastSeenAt: new Date() },
      });
    }

    return true;
  }
}
