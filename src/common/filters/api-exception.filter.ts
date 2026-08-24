import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiHttpException } from '../errors/api-errors';
import {
  PlatformWriteError,
  TenantScopeError,
} from '../../prisma/scoped-prisma';
import { getContext, RequestContext } from '../context/request-context';

/**
 * Task 7 — the single global exception filter.
 *
 * Renders every error as `{ code, message, ...extra, requestId }` (requestId is
 * pulled from the ALS RequestContext at render time). It also translates the
 * tenancy choke point's plain `Error` subclasses (which are thrown WITHOUT an
 * HTTP status because Task 4 has no HTTP awareness) into the correct HTTP codes.
 *
 * Denial auditing (§11 "permission denials"): for 403/423-class denials it
 * writes an append-only `audit_logs` row on the RAW client, stamped with
 * whatever the RequestContext holds at throw time. The write is fire-and-forget
 * and never allowed to throw out of the filter.
 */

/** Codes whose 403/423 denials must be recorded in the audit log. */
const DENIAL_CODES = new Set([
  'forbidden',
  'owner_suspended',
  'platform_write_forbidden',
  'tenant_scope_violation',
  'pin_locked',
  'login_locked',
]);

interface RenderedError {
  status: number;
  body: Record<string, unknown>;
}

@Injectable()
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly raw: PrismaService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpCtx = host.switchToHttp();
    const res = httpCtx.getResponse<Response>();

    const { status, body } = this.render(exception);

    // Attach requestId from the ALS context (absent outside a request scope).
    let requestId: string | undefined;
    try {
      requestId = getContext().requestId;
    } catch {
      // rendered outside a request scope — omit
    }
    if (requestId) body.requestId = requestId;

    res.status(status).json(body);

    const code = body.code as string | undefined;
    if (code && DENIAL_CODES.has(code)) {
      const message = typeof body.message === 'string' ? body.message : '';
      // Fire-and-forget; a failed denial-audit must never mask the response.
      void this.writeDenialAudit(code, message).catch(() => undefined);
    }
  }

  /** Map any thrown value to an HTTP status + serialized body. */
  private render(exception: unknown): RenderedError {
    // 1) Our own API errors — already carry code/message/extra.
    if (exception instanceof ApiHttpException) {
      return {
        status: exception.getStatus(),
        body: { ...(exception.getResponse() as Record<string, unknown>) },
      };
    }

    // 2) The tenancy choke point's plain Error subclasses (no HTTP awareness).
    if (exception instanceof PlatformWriteError) {
      return {
        status: HttpStatus.FORBIDDEN,
        body: {
          code: 'platform_write_forbidden',
          message: 'Platform scope may not write tenant data.',
        },
      };
    }
    if (exception instanceof TenantScopeError) {
      return {
        status: HttpStatus.FORBIDDEN,
        body: {
          code: 'tenant_scope_violation',
          message: 'This resource is outside your scope.',
        },
      };
    }

    // 3) Framework HttpExceptions (e.g. ValidationPipe, 404, passport 401).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        return {
          status,
          body: { code: this.defaultCode(status), message: resp },
        };
      }
      if (typeof resp === 'object' && resp !== null) {
        const body: Record<string, unknown> = {
          ...(resp as Record<string, unknown>),
        };
        // ValidationPipe emits { statusCode, error, message: string[] }.
        if (typeof body.code !== 'string') {
          body.code = this.defaultCode(status);
        }
        if (Array.isArray(body.message)) {
          body.message = (body.message as unknown[]).join('; ');
        }
        // Drop noisy framework-only fields.
        delete body.statusCode;
        delete body.error;
        return { status, body };
      }
    }

    // 4) Anything else — never leak internals.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
      },
    };
  }

  private defaultCode(status: number): string {
    switch (status) {
      case 422: // Unprocessable Entity
        return 'validation';
      case 401: // Unauthorized
        return 'unauthorized';
      case 403: // Forbidden
        return 'forbidden';
      case 404: // Not Found
        return 'not_found';
      default:
        return 'error';
    }
  }

  private async writeDenialAudit(code: string, message: string): Promise<void> {
    let ctx: RequestContext;
    try {
      ctx = getContext();
    } catch {
      return; // outside a request scope — nothing to stamp
    }

    // entityId is a UUID column; a denial has no entity, so leave it null.
    await this.raw.auditLog.create({
      data: {
        actorType: ctx.actor?.type ?? 'owner',
        actorId: ctx.actor?.id ?? null,
        ownerId: ctx.ownerId,
        action: `auth.denied.${code}`,
        entityType: 'request',
        entityId: null,
        changes: {},
        metadata: {
          requestId: ctx.requestId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          sessionId: ctx.sessionId,
          code,
          message,
        },
      },
    });
  }
}
