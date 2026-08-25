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

  /**
   * Task 10 — explicit platform-admin audit helper (§11).
   *
   * Owner/user provisioning + suspend/reinstate and every read-only tenant
   * browse run on the RAW client (or platform-scope ScopedPrisma, which does
   * NOT audit platform-model writes), so those admin actions are NOT captured by
   * the tenancy choke point. This writes the admin audit row directly.
   *
   * `actorType` is ALWAYS `platform_admin` and `businessId` is ALWAYS null (the
   * actor id comes from the platform-scope RequestContext). A null businessId +
   * the `platform_admin` actorType are the two locks that keep every admin row
   * out of a BO's tenant-scope activity log (Task 4 rule 2). The browse target
   * is recorded as `entityType`/`entityId` (+ `metadata.browsedBusinessId`), so
   * the admin log stays filterable per tenant.
   */
  async logAdmin(
    action: string,
    entityType: string,
    entityId: string | null,
    changes: Record<string, unknown> = {},
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
        actorType: 'platform_admin',
        actorId: ctx?.actor?.id ?? null,
        ownerId: null,
        // Immovable second lock: a platform-read/admin row NEVER carries a
        // businessId, so it can never match a tenant scope filter.
        businessId: null,
        branchId: null,
        action,
        entityType,
        entityId,
        changes: changes as Prisma.InputJsonValue,
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

  /**
   * Task 14 — explicit TENANT-scope audit helper for events the choke point does
   * NOT auto-capture: notably sensitive READS (e.g. the activity-log browse, §11)
   * and platform-model writes owned by a BO (e.g. the refund PIN could also use
   * `logAuth`). Stamps actor + owner from the RequestContext and the supplied
   * `businessId`, so the row surfaces in that business's own activity log.
   */
  async logPortal(
    action: string,
    entityType: string,
    entityId: string | null,
    businessId: string | null,
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
        actorType: ctx?.actor?.type ?? 'owner',
        actorId: ctx?.actor?.id ?? null,
        ownerId: ctx?.ownerId ?? null,
        businessId,
        branchId: null,
        action,
        entityType,
        entityId,
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
