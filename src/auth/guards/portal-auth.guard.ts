import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OwnerStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  UnauthorizedError,
  OwnerSuspendedError,
  ForbiddenError,
} from '../../common/errors/api-errors';
import { setAuthContext } from '../../common/context/request-context';
import { JwtPayload } from '../jwt.strategy';
import {
  assertPortalAction,
  MANAGER_ACCESS_KEY,
  ManagerAccessRule,
} from '../../staff/portal-scope';

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

    const req = context.switchToHttp().getRequest<{
      user?: JwtPayload;
      params?: Record<string, string>;
      query?: Record<string, string | undefined>;
    }>();
    const payload = req.user;
    if (!payload?.sub) throw new UnauthorizedError();

    const user = await this.raw.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) throw new UnauthorizedError();

    if (!user.ownerId || (user.role !== 'owner' && user.role !== 'manager')) {
      throw new ForbiddenError('Portal access requires an owner account.');
    }
    const owner = await this.raw.owner.findUnique({
      where: { id: user.ownerId },
    });
    // Fail closed: deny if the owner row is missing OR suspended. A dangling
    // ownerId (owner deleted/absent) must never grant portal access.
    if (!owner || SUSPENDED_STATUSES.has(owner.status)) {
      throw new OwnerSuspendedError();
    }

    if (user.role === 'manager') {
      if (payload.role !== 'manager' || !payload.sid)
        throw new UnauthorizedError();
      const session = await this.raw.refreshToken.findUnique({
        where: { id: payload.sid },
      });
      if (
        !session ||
        session.userId !== user.id ||
        session.revokedAt ||
        session.expiresAt <= new Date()
      ) {
        throw new UnauthorizedError(
          'Your manager session has ended. Sign in again.',
        );
      }
      const profile = await this.raw.staffProfile.findUnique({
        where: { userId: user.id },
        include: { branches: true, business: true },
      });
      if (
        !profile ||
        profile.deletedAt ||
        profile.status !== 'active' ||
        profile.business.deletedAt ||
        profile.business.ownerId !== user.ownerId ||
        !user.passwordHash ||
        !user.pinHash
      )
        throw new ForbiddenError('Manager access is not active.');
      const assigned = profile.branches
        .filter((branch) => !branch.deletedAt)
        .map((branch) => branch.branchId);
      const activeBranches = await this.raw.branch.findMany({
        where: {
          id: { in: assigned },
          businessId: profile.businessId,
          deletedAt: null,
        },
        select: { id: true },
      });
      const rule = (Reflect.getMetadata(
        MANAGER_ACCESS_KEY,
        context.getHandler(),
      ) ?? Reflect.getMetadata(MANAGER_ACCESS_KEY, context.getClass())) as
        ManagerAccessRule | undefined;
      if (!rule)
        throw new ForbiddenError(
          'This route is reserved for the business owner.',
        );
      const principal = {
        userId: user.id,
        ownerId: user.ownerId,
        role: 'manager' as const,
        businessId: profile.businessId,
        branchIds: activeBranches.map((branch) => branch.id),
      };
      let branchId = rule.branchParam
        ? req.params?.[rule.branchParam]
        : rule.analytics || rule.branchQuery
          ? req.query?.branchId
          : undefined;
      let businessId = rule.businessParam
        ? req.params?.[rule.businessParam]
        : rule.analytics
          ? req.query?.businessId
          : undefined;
      if (rule.branchParam && !branchId)
        throw new ForbiddenError('Branch is required.');
      if (rule.businessParam && !businessId)
        throw new ForbiddenError('Business is required.');
      if (rule.terminalParam) {
        const terminalId = req.params?.[rule.terminalParam];
        if (!terminalId) throw new ForbiddenError('Terminal is required.');
        const terminal = await this.raw.terminal.findUnique({
          where: { id: terminalId },
          select: { branchId: true, deletedAt: true },
        });
        if (!terminal || terminal.deletedAt) {
          throw new ForbiddenError('Terminal is outside your assignment.');
        }
        branchId = terminal.branchId;
      }
      if (rule.productParam) {
        const productId = req.params?.[rule.productParam];
        if (!productId) throw new ForbiddenError('Product is required.');
        const product = await this.raw.product.findUnique({
          where: { id: productId },
          select: { businessId: true, deletedAt: true },
        });
        if (!product || product.deletedAt) {
          throw new ForbiddenError('Product is outside your assignment.');
        }
        businessId = product.businessId;
      }
      assertPortalAction(principal, rule.action, branchId, businessId);
      setAuthContext({
        scope: 'tenant',
        actor: { type: 'staff', id: user.id },
        ownerId: user.ownerId,
        managerBusinessId: profile.businessId,
        managerBranchIds: principal.branchIds,
        businessId: profile.businessId,
        branchId:
          rule.branchParam || rule.terminalParam || rule.branchQuery
            ? (branchId ?? null)
            : null,
        sessionId: payload.sid,
      });
      return true;
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
