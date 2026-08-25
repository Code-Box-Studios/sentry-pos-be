import { Inject, Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import { AuditService } from '../../auth/audit.service';
import { Paginated } from '../../common/types/pagination';
import { assertBusinessOwned } from '../shared/tenant-guards';
import { ActivityLogQueryDto } from './dto/activity-log-query.dto';

const DEFAULT_PAGE_SIZE = 50;

/**
 * Task 14 — BO-facing activity log (tenant scope). Reads flow through the
 * ScopedPrisma choke point, whose auditLog rule already excludes platform rows
 * and admits businessId-null rows whose ownerId matches — so the owner sees this
 * business's rows PLUS their own account/auth events, but never platform access.
 * The read is itself a sensitive event (§11): a `audit.activity_log_read` row is
 * appended after each successful read.
 */
@Injectable()
export class ActivityLogService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly audit: AuditService,
  ) {}

  async list(
    businessId: string,
    query: ActivityLogQueryDto,
  ): Promise<Paginated<AuditLog>> {
    await assertBusinessOwned(this.scoped, businessId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    // Base scope: this business's rows + the owner's account-level
    // (businessId-null) events. The choke point ANDs in the tenant auditLog rule
    // (excludes platform rows). The optional filters below NARROW that scope — a
    // branchId/actorType/action filter deliberately restricts to matching rows
    // (so, e.g., a branch filter drops account-level events, which aren't branch
    // activity); the unfiltered view is where the owner sees their own events.
    const where: Prisma.AuditLogWhereInput = {
      OR: [{ businessId }, { businessId: null }],
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.actorType ? { actorType: query.actorType } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.scoped.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.scoped.auditLog.count({ where }),
    ]);

    // Sensitive read (§11): entityType/entityId identify the browsed business
    // (collection-browse pattern, mirroring Task 10's admin browse).
    await this.audit.logPortal(
      'audit.activity_log_read',
      'business',
      businessId,
      businessId,
    );

    return {
      data,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}
