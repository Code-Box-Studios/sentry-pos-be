import { InspectQueryDto } from './dto/inspect-query.dto';
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

  async metrics() {
    const owners = await this.scoped.owner.findMany({
      select: { status: true },
    });
    const [businesses, branches, terminals, openShifts] = await Promise.all([
      this.scoped.business.count(),
      this.scoped.branch.count(),
      this.scoped.terminal.count(),
      this.scoped.shift.count({ where: { closedAt: null } }),
    ]);
    const count = (status: string) =>
      owners.filter((o) => o.status === status).length;
    await this.audit.logAdmin('admin.metrics.read', 'platform', null);
    return {
      owners: {
        total: owners.length,
        active: count('active'),
        suspended: count('suspended'),
        hardSuspended: count('hard_suspended'),
        closed: count('closed'),
      },
      businesses,
      branches,
      terminals,
      openShifts,
    };
  }
  async inspect(businessId: string, query: InspectQueryDto) {
    await this.assertBusinessExists(businessId);
    const page = query.page,
      pageSize = query.pageSize;
    const paging = {
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' as const },
    };
    const branchWhere = { branch: { businessId } };
    let data: unknown[], total: number;
    switch (query.section) {
      case 'catalog':
        [data, total] = await Promise.all([
          this.scoped.product.findMany({
            where: { businessId },
            include: { variants: true },
            ...paging,
          }),
          this.scoped.product.count({ where: { businessId } }),
        ]);
        break;
      case 'sales':
        [data, total] = await Promise.all([
          this.scoped.sale.findMany({
            where: branchWhere,
            select: {
              id: true,
              receiptNo: true,
              branchId: true,
              terminalId: true,
              createdAt: true,
              createdAtDevice: true,
              status: true,
              total: true,
              subtotal: true,
              discount: true,
              tax: true,
              serviceCharge: true,
            },
            ...paging,
          }),
          this.scoped.sale.count({ where: branchWhere }),
        ]);
        break;
      case 'payments':
        [data, total] = await Promise.all([
          this.scoped.salePayment.findMany({
            where: { sale: branchWhere },
            ...paging,
          }),
          this.scoped.salePayment.count({ where: { sale: branchWhere } }),
        ]);
        break;
      case 'shifts':
        [data, total] = await Promise.all([
          this.scoped.shift.findMany({ where: branchWhere, ...paging }),
          this.scoped.shift.count({ where: branchWhere }),
        ]);
        break;
      case 'stock':
        [data, total] = await Promise.all([
          this.scoped.branchStock.findMany({ where: branchWhere, ...paging }),
          this.scoped.branchStock.count({ where: branchWhere }),
        ]);
        break;
      case 'counts':
        [data, total] = await Promise.all([
          this.scoped.stockCount.findMany({
            where: branchWhere,
            include: { items: true },
            ...paging,
          }),
          this.scoped.stockCount.count({ where: branchWhere }),
        ]);
        break;
      case 'terminals': {
        const rows = await this.scoped.terminal.findMany({
          where: branchWhere,
          ...paging,
        });
        data = rows.map(({ deviceTokenHash, ...terminal }) => ({
          ...terminal,
          paired: deviceTokenHash !== null,
        }));
        total = await this.scoped.terminal.count({ where: branchWhere });
        break;
      }
    }
    await this.audit.logAdmin(
      'admin.browse.inspect',
      'business',
      businessId,
      {},
      { browsedBusinessId: businessId, section: query.section, page },
    );
    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

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
