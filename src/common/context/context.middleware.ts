import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { requestContext, RequestContext } from './request-context';

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();

    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim() ??
      req.socket.remoteAddress ??
      '';

    const userAgent = req.headers['user-agent'] ?? '';

    const deviceTimestamp =
      (req.headers['x-device-timestamp'] as string | undefined) ?? null;

    const store: RequestContext = {
      requestId,
      scope: null,
      actor: null,
      ownerId: null,
      businessId: null,
      branchId: null,
      terminalCode: null,
      sessionId: null,
      ip,
      userAgent,
      deviceTimestamp,
    };

    res.setHeader('X-Request-Id', requestId);

    requestContext.run(store, () => next());
  }
}
