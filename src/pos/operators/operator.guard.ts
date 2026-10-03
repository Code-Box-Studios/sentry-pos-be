import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  getContext,
  setAuthContext,
} from '../../common/context/request-context';
import { OperatorSessionError as UnauthorizedError } from '../../common/errors/api-errors';
import { PrismaService } from '../../prisma/prisma.service';

const IDLE_MS = 5 * 60 * 1000;

@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly raw: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = getContext();
    const req = context.switchToHttp().getRequest<{
      headers: { 'x-operator-token'?: string };
    }>();
    const token = req.headers['x-operator-token'];
    if (
      !token ||
      !ctx.terminalId ||
      !ctx.branchId ||
      !ctx.ownerId ||
      !ctx.businessId
    ) {
      throw new UnauthorizedError('Unlock this terminal to continue.');
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const session = await this.raw.operatorSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            owner: true,
            staffProfile: { include: { branches: true } },
          },
        },
      },
    });
    const now = new Date();
    if (
      !session ||
      session.revokedAt ||
      session.terminalId !== ctx.terminalId ||
      session.branchId !== ctx.branchId ||
      session.expiresAt <= now ||
      now.getTime() - session.lastActivityAt.getTime() >= IDLE_MS
    )
      throw new UnauthorizedError('Operator session expired or revoked.');
    const user = session.user;
    if (user.deletedAt || user.ownerId !== ctx.ownerId)
      throw new UnauthorizedError();
    let name: string;
    if (user.role === 'owner') {
      if (!user.owner || user.owner.deletedAt) throw new UnauthorizedError();
      name = user.owner.name;
    } else if (user.role === 'manager' || user.role === 'cashier') {
      const profile = user.staffProfile;
      if (
        !profile ||
        profile.deletedAt ||
        profile.status !== 'active' ||
        profile.businessId !== ctx.businessId ||
        !profile.branches.some(
          (branch) => branch.branchId === ctx.branchId && !branch.deletedAt,
        )
      )
        throw new UnauthorizedError();
      name = profile.name;
    } else throw new UnauthorizedError();
    await this.raw.operatorSession.update({
      where: { id: session.id },
      data: { lastActivityAt: now },
    });
    setAuthContext({
      operator: { userId: user.id, name, role: user.role },
      operatorSessionId: session.id,
    });
    return true;
  }
}

/** Startup can read drawer identity without exposing its financial details. */
@Injectable()
export class OptionalOperatorGuard extends OperatorGuard {
  constructor(raw: PrismaService) {
    super(raw);
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: { 'x-operator-token'?: string } }>();
    return req.headers['x-operator-token'] ? super.canActivate(context) : true;
  }
}
