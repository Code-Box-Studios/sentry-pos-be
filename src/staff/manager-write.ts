import type { Prisma } from '@prisma/client';
import { getContext } from '../common/context/request-context';
import { ForbiddenError } from '../common/errors/api-errors';

/** Called after the resource lock; holds the manager's authority until commit. */
export async function assertManagerWrite(
  tx: Prisma.TransactionClient,
  businessId: string,
  branchId: string,
): Promise<void> {
  const ctx = getContext();
  if (ctx.actor?.type !== 'staff') return;
  const userId = ctx.actor.id;
  if (!ctx.sessionId)
    throw new ForbiddenError('Your manager session has ended.');
  await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM refresh_tokens WHERE id=${ctx.sessionId}::uuid FOR UPDATE`;
  const [user, session, branch] = await Promise.all([
    tx.user.findUnique({
      where: { id: userId },
      include: { staffProfile: { include: { branches: true } } },
    }),
    tx.refreshToken.findUnique({ where: { id: ctx.sessionId } }),
    tx.branch.findUnique({
      where: { id: branchId },
      include: { business: { include: { owner: true } } },
    }),
  ]);
  const profile = user?.staffProfile;
  if (
    !user ||
    user.deletedAt ||
    user.role !== 'manager' ||
    !user.passwordHash ||
    !user.pinHash ||
    !profile ||
    profile.deletedAt ||
    profile.status !== 'active' ||
    profile.businessId !== businessId ||
    !profile.branches.some(
      (assignment) => assignment.branchId === branchId && !assignment.deletedAt,
    ) ||
    !session ||
    session.userId !== userId ||
    session.revokedAt ||
    session.expiresAt <= new Date() ||
    !branch ||
    branch.deletedAt ||
    branch.businessId !== businessId ||
    branch.business.deletedAt ||
    branch.business.ownerId !== user.ownerId ||
    user.ownerId !== ctx.ownerId ||
    branch.business.owner.deletedAt ||
    ['suspended', 'hard_suspended', 'closed'].includes(
      branch.business.owner.status,
    )
  ) {
    throw new ForbiddenError(
      'Your manager access changed. Sign in again before changing this branch.',
    );
  }
}
