import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OwnerStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  UnauthorizedError,
  OwnerSuspendedError,
} from '../../common/errors/api-errors';
import { setAuthContext } from '../../common/context/request-context';
import { JwtPayload } from '../jwt.strategy';

const SUSPENDED_STATUSES: ReadonlySet<OwnerStatus> = new Set<OwnerStatus>([
  OwnerStatus.suspended,
  OwnerStatus.hard_suspended,
  OwnerStatus.closed,
]);

/**
 * Guards portal (tenant) routes. Verifies the access JWT (via the shared
 * strategy, which already rejects `kind: "preauth"`), loads the user + owner,
 * enforces the owner-status gate (§8), then stamps the tenant scope onto the
 * RequestContext so the choke point sees an authenticated tenant caller.
 */
@Injectable()
export class PortalAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly raw: PrismaService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let passed: boolean;
    try {
      passed = (await super.canActivate(context)) as boolean;
    } catch {
      throw new UnauthorizedError();
    }
    if (!passed) throw new UnauthorizedError();

    const req = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const payload = req.user;
    if (!payload?.sub) throw new UnauthorizedError();

    const user = await this.raw.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) throw new UnauthorizedError();

    if (user.ownerId) {
      const owner = await this.raw.owner.findUnique({
        where: { id: user.ownerId },
      });
      // Fail closed: deny if the owner row is missing OR suspended. A dangling
      // ownerId (owner deleted/absent) must never grant portal access.
      if (!owner || SUSPENDED_STATUSES.has(owner.status)) {
        throw new OwnerSuspendedError();
      }
    }

    setAuthContext({
      scope: 'tenant',
      actor: { type: 'owner', id: user.id },
      ownerId: user.ownerId ?? null,
      sessionId: payload.sid,
    });

    return true;
  }
}
