import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  UnauthorizedError,
  ForbiddenError,
} from '../../common/errors/api-errors';
import { setAuthContext } from '../../common/context/request-context';
import { JwtPayload } from '../jwt.strategy';

/**
 * Guards platform-admin routes. Verifies the access JWT (rejecting preauth via
 * the shared strategy), requires `role === "platform_admin"`, then stamps the
 * platform scope onto the RequestContext.
 */
@Injectable()
export class AdminGuard extends AuthGuard('jwt') {
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

    if (payload.role !== 'platform_admin') {
      throw new ForbiddenError('Platform admin access required.');
    }

    setAuthContext({
      scope: 'platform',
      actor: { type: 'platform_admin', id: payload.sub },
      ownerId: null,
      sessionId: payload.sid,
    });

    return true;
  }
}
