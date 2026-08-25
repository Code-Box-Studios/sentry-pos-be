import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedError } from '../common/errors/api-errors';

/** Shape of a verified access-token payload. */
export interface JwtPayload {
  sub: string;
  role: string;
  ownerId?: string;
  sid: string;
  /** Present ONLY on preauth tokens; the strategy rejects those outright. */
  kind?: string;
  /** Present ONLY on scoped tokens (e.g. pairing); the strategy rejects those. */
  aud?: string;
}

/**
 * The access-token strategy. Passport verifies signature + expiry using
 * JWT_ACCESS_SECRET; `validate()` then rejects scoped tokens signed with the
 * same secret so they can never authenticate a normal protected route: a
 * `kind: "preauth"` token (only Task 8's TOTP endpoints consume it) and any
 * `aud`-bearing token (e.g. Task 16's pairing token, which is verified directly
 * by its own PairingGuard, never here).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    if (payload.kind === 'preauth') {
      throw new UnauthorizedError(
        'Pre-auth tokens cannot access protected routes.',
      );
    }
    if (payload.aud) {
      throw new UnauthorizedError(
        'Scoped tokens cannot access protected routes.',
      );
    }
    return payload;
  }
}
