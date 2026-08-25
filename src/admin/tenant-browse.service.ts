import { Inject, Injectable } from '@nestjs/common';
import { AuditLog, Branch, Business, Prisma } from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../prisma/scoped-prisma.provider';
import { AuditService } from '../auth/audit.service';
import { NotFoundError } from '../common/errors/api-errors';
import { Paginated } from '../common/types/pagination';
import { ActivityLogQueryDto } from './dto/activity-log-query.dto';

/** Default page size for the paginated activity-log browse. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Task 10 — audited, read-only platform browse of tenant data (§4/§11).
 *
 * All reads go through the ScopedPrisma **platform** scope: platform reads see
 * every tenant's rows (so an accidental write here would throw
 * `PlatformWriteError`, mapped to 403 `platform_write_forbidden`). Platform-scope
 * reads are NOT auto-filtered, so each method pins the target owner/business in
 * its own `where`.
 *
 * Every browse writes ONE platform-side admin audit row via `logAdmin`:
 * `actorType: platform_admin`, `businessId: null` (the two locks that keep it out
 * of a BO's tenant-scope activity log — Task 4 rule 2). The browse target is the
 * row's `entityType`/`entityId`; the owning business also rides in
 * `metadata.browsedBusinessId`, keeping the admin log filterable per tenant.
 */
@Injectable()
export class TenantBrowseService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly audit: AuditService,
  ) {}

  async businesses(ownerId: string): Promise<Business[]> {
    await this.assertOwnerExists(ownerId);
    const businesses = await this.scoped.business.findMany({
      where: { ownerId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    // Target is the owner; no single browsedBusinessId for a multi-business read.
    await this.audit.logAdmin('admin.browse.businesses', 'owner', ownerId);
    return businesses;
  }

  async branches(businessId: string): Promise<Branch[]> {
    await this.assertBusinessExists(businessId);
    const branches = await this.scoped.branch.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    await this.audit.logAdmin(
      'admin.browse.branches',
      'business',
      businessId,
      {},
      { browsedBusinessId: businessId },
    );
    return branches;
  }

  async activityLog(
    businessId: string,
    query: ActivityLogQueryDto,
  ): Promise<Paginated<AuditLog>> {
    await this.assertBusinessExists(businessId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.AuditLogWhereInput = {
      businessId,
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

    await this.audit.logAdmin(
      'admin.browse.activity_log',
      'business',
      businessId,
      {},
      { browsedBusinessId: businessId },
    );

    return {
      data,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /**
   * Fail with 404 (not a silent empty result) when the browse target does not
   * exist — consistent with `OwnersService.get` and keeps us from auditing a
   * browse of a phantom entity. Reads go through the platform scope, which sees
   * every tenant's rows.
   */
  private async assertOwnerExists(ownerId: string): Promise<void> {
    const owner = await this.scoped.owner.findFirst({
      where: { id: ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!owner) throw new NotFoundError('Owner not found.');
  }

  private async assertBusinessExists(businessId: string): Promise<void> {
    const business = await this.scoped.business.findFirst({
      where: { id: businessId, deletedAt: null },
      select: { id: true },
    });
    if (!business) throw new NotFoundError('Business not found.');
  }
}
