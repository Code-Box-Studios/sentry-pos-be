import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getContext } from '../common/context/request-context';
import { ForbiddenError, NotFoundError } from '../common/errors/api-errors';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly raw: PrismaService) {}

  private async scope(): Promise<Prisma.NotificationWhereInput> {
    const { actor, ownerId, scope } = getContext();
    if (scope !== 'tenant' || actor?.type !== 'owner' || !ownerId)
      throw new ForbiddenError();
    // Notifications have no Prisma business relation: prove BOTH recipient and business ownership.
    const businesses = await this.raw.business.findMany({
      where: { ownerId, deletedAt: null, isDemo: false },
      select: { id: true },
    });
    return {
      recipientType: 'user',
      recipientId: actor.id,
      businessId: { in: businesses.map((b) => b.id) },
      deletedAt: null,
    };
  }

  async list(page: number, pageSize: number, unreadOnly: boolean) {
    const scope = await this.scope();
    const where = { ...scope, ...(unreadOnly ? { readAt: null } : {}) };
    const [items, total, unreadCount] = await this.raw.$transaction([
      this.raw.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          businessId: true,
          branchId: true,
          entityId: true,
          readAt: true,
          resolvedAt: true,
          createdAt: true,
        },
      }),
      this.raw.notification.count({ where }),
      this.raw.notification.count({ where: { ...scope, readAt: null } }),
    ]);
    return { items, total, unreadCount, page, pageSize };
  }

  async read(id: string) {
    const scope = await this.scope();
    if (
      !(await this.raw.notification.findFirst({
        where: { ...scope, id },
        select: { id: true },
      }))
    )
      throw new NotFoundError('Notification not found.');
    await this.raw.notification.updateMany({
      where: { ...scope, id, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true as const };
  }

  async readAll() {
    await this.raw.notification.updateMany({
      where: { ...(await this.scope()), readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true as const };
  }
}
