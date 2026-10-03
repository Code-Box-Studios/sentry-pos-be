import { Controller, Get, UseGuards } from '@nestjs/common';
import { PortalAuthGuard } from '../auth/guards/portal-auth.guard';
import { getContext } from '../common/context/request-context';
import { ForbiddenError } from '../common/errors/api-errors';
import { PrismaService } from '../prisma/prisma.service';
import { ManagerAccess } from './portal-scope';

@Controller('portal/manager')
@UseGuards(PortalAuthGuard)
export class ManagerContextController {
  constructor(private readonly raw: PrismaService) {}

  @Get('context')
  @ManagerAccess({ action: 'portal_catalog_read' })
  async context() {
    const ctx = getContext();
    if (ctx.actor?.type !== 'staff' || !ctx.managerBusinessId) {
      throw new ForbiddenError('Manager context requires a manager account.');
    }
    const [profile, business, branches] = await Promise.all([
      this.raw.staffProfile.findUnique({
        where: { userId: ctx.actor.id },
        select: { name: true },
      }),
      this.raw.business.findUnique({
        where: { id: ctx.managerBusinessId },
        select: { id: true, name: true, dayStartTime: true },
      }),
      this.raw.branch.findMany({
        where: {
          id: { in: ctx.managerBranchIds ?? [] },
          businessId: ctx.managerBusinessId,
          deletedAt: null,
        },
        select: { id: true, name: true, code: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    if (!profile || !business)
      throw new ForbiddenError('Manager assignment is unavailable.');
    return {
      userId: ctx.actor.id,
      name: profile.name,
      role: 'manager',
      business,
      branches,
    };
  }

  @Get('alerts')
  @ManagerAccess({ action: 'portal_stock' })
  async alerts() {
    const ctx = getContext();
    if (ctx.actor?.type !== 'staff' || !ctx.managerBusinessId) {
      throw new ForbiddenError('Manager alerts require a manager account.');
    }
    return this.raw.notification.findMany({
      where: {
        businessId: ctx.managerBusinessId,
        branchId: { in: ctx.managerBranchIds ?? [] },
        type: 'low_stock',
        resolvedAt: null,
        deletedAt: null,
      },
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        businessId: true,
        branchId: true,
        entityId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
  }

  @Get('transfer-branches')
  @ManagerAccess({ action: 'portal_stock' })
  async transferBranches() {
    const ctx = getContext();
    if (ctx.actor?.type !== 'staff' || !ctx.managerBusinessId) {
      throw new ForbiddenError(
        'Transfer destinations require a manager account.',
      );
    }
    // Names only: a manager may send stock to another branch of this business,
    // but this endpoint grants no access to its inventory or other data.
    return this.raw.branch.findMany({
      where: { businessId: ctx.managerBusinessId, deletedAt: null },
      select: { id: true, name: true, businessId: true },
      orderBy: { name: 'asc' },
    });
  }
}
