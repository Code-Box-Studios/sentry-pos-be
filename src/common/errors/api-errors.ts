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
// Validation error
// ---------------------------------------------------------------------------

export class ValidationFailedError extends ApiHttpException {
  constructor(message: string) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'validation', message);
  }
}
