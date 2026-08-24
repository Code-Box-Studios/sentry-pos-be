import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedError } from '../../common/errors/api-errors';

export interface PreauthPayload {
  sub: string;
  kind: string;
  iat?: number;
  exp?: number;
}

/**
 * Guards TOTP setup and enable endpoints. Accepts ONLY tokens with
 * `kind: "preauth"`. Rejects access tokens (no `kind` field), expired tokens,
 * garbage tokens, and missing headers.
 *
 * Attaches the verified payload to `req.preauthUser` so the controller can
 * read the user id without re-verifying.
 */
@Injectable()
export class PreauthGuard implements CanActivate {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      preauthUser?: PreauthPayload;
    }>();

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Pre-auth token required.');
    }

    const token = authHeader.slice(7);
    let payload: PreauthPayload;

    try {
      payload = this.jwt.verify<PreauthPayload>(token, {
        secret: this.secret,
      });
    } catch {
      throw new UnauthorizedError('Invalid or expired pre-auth token.');
    }

    if (payload.kind !== 'preauth') {
      throw new UnauthorizedError('Pre-auth token required.');
    }

    req.preauthUser = payload;
    return true;
  }
}
