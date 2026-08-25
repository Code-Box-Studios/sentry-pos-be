import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedError } from '../../common/errors/api-errors';

export interface PairingPayload {
  sub: string;
  ownerId?: string;
  aud?: string;
}

/** Attached to the request by PairingGuard for the pairing controller. */
export interface RequestWithPairing {
  pairing: { ownerId: string; userId: string };
}

/**
 * Task 16 — guards the pairing browse/pair routes. Accepts ONLY a 10-min
 * pairing token (`aud: "pairing"`); rejects access tokens, preauth tokens,
 * expired/garbage tokens, and missing headers. Attaches `{ ownerId, userId }`
 * to the request; the pairing service reads the owner's businesses via the raw
 * client (this is a pre-tenant flow, not a scoped-client surface).
 */
@Injectable()
export class PairingGuard implements CanActivate {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<
        { headers: { authorization?: string } } & Partial<RequestWithPairing>
      >();

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Pairing token required.');
    }

    let payload: PairingPayload;
    try {
      payload = this.jwt.verify<PairingPayload>(authHeader.slice(7), {
        secret: this.secret,
      });
    } catch {
      throw new UnauthorizedError('Invalid or expired pairing token.');
    }

    if (payload.aud !== 'pairing' || !payload.ownerId || !payload.sub) {
      throw new UnauthorizedError('Pairing token required.');
    }

    req.pairing = { ownerId: payload.ownerId, userId: payload.sub };
    return true;
  }
}
