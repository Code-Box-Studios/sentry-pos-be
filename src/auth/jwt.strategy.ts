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
}

/**
 * The access-token strategy. Passport verifies signature + expiry using
 * JWT_ACCESS_SECRET; `validate()` then rejects any token carrying
 * `kind: "preauth"` so a password-only preauth token can never authenticate a
 * protected route (only Task 8's TOTP endpoints consume preauth tokens).
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
    return payload;
  }
}
