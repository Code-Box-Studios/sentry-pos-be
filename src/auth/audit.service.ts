import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getContext, RequestContext } from '../common/context/request-context';

/** Minimal write surface shared by the raw client and a transaction client. */
type AuditClient = Pick<PrismaService, 'auditLog'> | Prisma.TransactionClient;

/**
 * Task 7 — explicit auth-event audit helper (§11 auth events).
 *
 * Auth runs on the RAW client (pre-scope), so login/logout events are NOT
 * captured by the tenancy choke point's mutation-audit. This service writes
 * those rows directly, mirroring Task 6's PIN-failure audit pattern. `ownerId`
 * is stamped whenever the attempted identity resolves to an owner user, so a
 * BO's activity log surfaces their own auth events.
 */
@Injectable()
export class AuditService {
  constructor(private readonly raw: PrismaService) {}

  /**
   * @param action  e.g. 'auth.login', 'auth.login_failed', 'auth.logout',
   *                'auth.login_preauth'
   * @param userId  the user being authenticated (audit entity)
   * @param ownerId the owner the user belongs to (null for platform admins)
   * @param meta    extra metadata merged into the row
   * @param client  optional Prisma client — pass a transaction client to write
   *                the audit row INSIDE a `$transaction` (so it rolls back with
   *                the flow). Defaults to the raw client.
   */
  async logAuth(
    action: string,
    userId: string,
    ownerId: string | null,
    meta: Record<string, unknown> = {},
    client: AuditClient = this.raw,
  ): Promise<void> {
    let ctx: RequestContext | null = null;
    try {
      ctx = getContext();
    } catch {
      // called outside a request scope (e.g. unit tests) — use empty metadata
    }

    await client.auditLog.create({
      data: {
        actorType: ownerId ? 'owner' : 'platform_admin',
        actorId: userId,
        ownerId,
        action,
        entityType: 'user',
        entityId: userId,
        changes: {},
        metadata: {
          requestId: ctx?.requestId ?? null,
          ip: ctx?.ip ?? null,
          userAgent: ctx?.userAgent ?? null,
          sessionId: ctx?.sessionId ?? null,
          ...meta,
        },
      },
    });
  }
}
