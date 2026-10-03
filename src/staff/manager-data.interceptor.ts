import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { getContext } from '../common/context/request-context';

export const SENSITIVE_FIELD =
  /cost|profit|margin|cogs|^valueC$|^total value$/i;

export function withoutSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSensitiveFields);
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_FIELD.test(key))
        .map(([key, child]) => [key, withoutSensitiveFields(child)]),
    );
  }
  return value;
}

/** Defense in depth for manager JSON responses; CSV is filtered in renderReport. */
@Injectable()
export class ManagerDataInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ originalUrl?: string }>();
    let staffPortal = false;
    try {
      staffPortal =
        getContext().actor?.type === 'staff' &&
        Boolean(req.originalUrl?.startsWith('/v1/portal/'));
    } catch {
      // Non-request invocations have no portal staff context.
    }
    return staffPortal
      ? next.handle().pipe(map(withoutSensitiveFields))
      : next.handle();
  }
}
