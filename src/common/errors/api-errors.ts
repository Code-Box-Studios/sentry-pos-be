import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Base HTTP exception for all API errors.
 * Task 7 will extend this file with additional subclasses and a global exception filter.
 */
export class ApiHttpException extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super({ code, message, ...extra }, status);
  }
}

// ---------------------------------------------------------------------------
// PIN errors
// ---------------------------------------------------------------------------

export class PinInvalidError extends ApiHttpException {
  constructor(attemptsRemaining: number) {
    super(HttpStatus.FORBIDDEN, 'pin_invalid', 'PIN is incorrect.', {
      attemptsRemaining,
    });
  }
}

export class PinLockedError extends ApiHttpException {
  constructor(retryAfterSeconds: number) {
    super(
      HttpStatus.LOCKED,
      'pin_locked',
      'PIN entry is temporarily locked due to too many failed attempts.',
      { retryAfterSeconds },
    );
  }
}

// ---------------------------------------------------------------------------
// Login errors
// ---------------------------------------------------------------------------

export class LoginInvalidError extends ApiHttpException {
  constructor(attemptsRemaining: number) {
    super(
      HttpStatus.UNAUTHORIZED,
      'login_invalid',
      'Credentials are incorrect.',
      {
        attemptsRemaining,
      },
    );
  }
}

export class LoginLockedError extends ApiHttpException {
  constructor(retryAfterSeconds: number) {
    super(
      HttpStatus.LOCKED,
      'login_locked',
      'Login is temporarily locked due to too many failed attempts.',
      { retryAfterSeconds },
    );
  }
}

// ---------------------------------------------------------------------------
// TOTP errors (Task 8)
// ---------------------------------------------------------------------------

export class TotpInvalidError extends ApiHttpException {
  constructor() {
    super(
      HttpStatus.UNAUTHORIZED,
      'totp_invalid',
      'TOTP code or recovery code is invalid.',
    );
  }
}

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

export class ValidationFailedError extends ApiHttpException {
  constructor(message: string) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'validation', message);
  }
}

// ---------------------------------------------------------------------------
// Auth / authorization errors (Task 7)
// ---------------------------------------------------------------------------

export class UnauthorizedError extends ApiHttpException {
  constructor(message = 'Authentication is required.') {
    super(HttpStatus.UNAUTHORIZED, 'unauthorized', message);
  }
}

export class ForbiddenError extends ApiHttpException {
  constructor(message = 'You do not have permission to perform this action.') {
    super(HttpStatus.FORBIDDEN, 'forbidden', message);
  }
}

export class NotFoundError extends ApiHttpException {
  constructor(message = 'The requested resource was not found.') {
    super(HttpStatus.NOT_FOUND, 'not_found', message);
  }
}

/**
 * A unique email collided with an existing owner/user row (Prisma P2002). Mapped
 * from the raw constraint error so the client gets a stable 409 instead of a 500.
 */
export class EmailTakenError extends ApiHttpException {
  constructor(message = 'This email is already in use.') {
    super(HttpStatus.CONFLICT, 'email_taken', message);
  }
}

/**
 * Portal access is locked whenever the owner is suspended/hard_suspended/closed
 * (§8). Returned by both login and the PortalAuthGuard.
 */
export class OwnerSuspendedError extends ApiHttpException {
  constructor() {
    super(
      HttpStatus.FORBIDDEN,
      'owner_suspended',
      'This account is suspended. Contact support.',
    );
  }
}

/**
 * The tenancy choke point throws a plain `PlatformWriteError` when platform
 * scope attempts a tenant write. The global filter maps that to this HTTP error
 * so the response carries the stable `platform_write_forbidden` code and the
 * denial is audited.
 */
export class PlatformWriteForbiddenError extends ApiHttpException {
  constructor(message = 'Platform scope may not write tenant data.') {
    super(HttpStatus.FORBIDDEN, 'platform_write_forbidden', message);
  }
}

// ---------------------------------------------------------------------------
// Token errors (Task 9 — invite / password-reset)
// ---------------------------------------------------------------------------

/**
 * A single-use invite or reset token was invalid: unknown, already consumed, or
 * expired. Deliberately generic (400) so it never reveals which of those it was.
 */
export class InvalidTokenError extends ApiHttpException {
  constructor(message = 'This link is invalid or has expired.') {
    super(HttpStatus.BAD_REQUEST, 'invalid_token', message);
  }
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class StockConflictHttpError extends ApiHttpException {
  constructor(conflicts: unknown[]) {
    super(HttpStatus.CONFLICT, 'stock_conflict', 'Stock conflict detected.', {
      conflicts,
    });
  }
}
