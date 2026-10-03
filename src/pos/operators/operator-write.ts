import { Prisma } from '@prisma/client';
import { getContext } from '../../common/context/request-context';
import {
  OwnerSuspendedError,
  OperatorSessionError,
  UnauthorizedError,
} from '../../common/errors/api-errors';

const IDLE_MS = 5 * 60_000;

/** Call while holding the terminal lock; pairing and ancestor status must still match. */
export async function assertTerminalWrite(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const ctx = getContext();
  if (!ctx.terminalId || !ctx.deviceTokenHash) throw new UnauthorizedError();
  const terminal = await tx.terminal.findUnique({
    where: { id: ctx.terminalId },
    include: {
      branch: { include: { business: { include: { owner: true } } } },
    },
  });
  if (
    !terminal ||
    terminal.deletedAt ||
    terminal.deviceTokenHash !== ctx.deviceTokenHash ||
    terminal.branchId !== ctx.branchId ||
    terminal.branch.deletedAt ||
    terminal.branch.businessId !== ctx.businessId ||
    terminal.branch.business.deletedAt ||
    terminal.branch.business.ownerId !== ctx.ownerId
  )
    throw new UnauthorizedError();
  const owner = terminal.branch.business.owner;
  if (
    owner.deletedAt ||
    owner.status === 'hard_suspended' ||
    owner.status === 'closed'
  ) {
    throw new UnauthorizedError();
  }
  if (owner.status === 'suspended') {
    const withinGrace =
      owner.suspendedAt &&
      Date.now() - owner.suspendedAt.getTime() < 24 * 60 * 60 * 1000;
    const open =
      withinGrace &&
      (await tx.shift.findFirst({
        where: { terminalId: terminal.id, closedAt: null, deletedAt: null },
        select: { id: true },
      }));
    if (!open) throw new OwnerSuspendedError();
  }
}

/** Revalidate the device and human inside the same transaction as a POS write. */
export async function assertOperatorWrite(
  tx: Prisma.TransactionClient,
): Promise<string> {
  const ctx = getContext();
  const operator = ctx.operator;
  const sessionId = ctx.operatorSessionId;
  if (
    !operator ||
    !sessionId ||
    !ctx.terminalId ||
    !ctx.branchId ||
    !ctx.businessId ||
    !ctx.ownerId
  ) {
    throw new OperatorSessionError('Unlock this terminal to continue.');
  }

  // Owner staff mutations take the user lock before changing assignments and
  // revoking sessions. The session lock also serializes manual lock/unpair.
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${operator.userId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM operator_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
  await assertTerminalWrite(tx);
  const session = await tx.operatorSession.findUnique({
    where: { id: sessionId },
    include: {
      user: {
        include: { owner: true, staffProfile: { include: { branches: true } } },
      },
    },
  });
  const now = new Date();
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= now ||
    now.getTime() - session.lastActivityAt.getTime() >= IDLE_MS ||
    session.userId !== operator.userId ||
    session.terminalId !== ctx.terminalId ||
    session.branchId !== ctx.branchId
  ) {
    throw new OperatorSessionError('Operator session expired or revoked.');
  }
  const user = session.user;
  if (
    user.deletedAt ||
    user.ownerId !== ctx.ownerId ||
    user.role !== operator.role
  ) {
    throw new OperatorSessionError();
  }
  if (user.role === 'owner') {
    if (
      !user.owner ||
      user.owner.deletedAt ||
      user.owner.status === 'hard_suspended' ||
      user.owner.status === 'closed'
    )
      throw new OperatorSessionError();
  } else if (user.role === 'manager' || user.role === 'cashier') {
    const profile = user.staffProfile;
    if (
      !profile ||
      profile.deletedAt ||
      profile.status !== 'active' ||
      profile.businessId !== ctx.businessId ||
      !profile.branches.some(
        (branch) => branch.branchId === ctx.branchId && !branch.deletedAt,
      )
    ) {
      throw new OperatorSessionError();
    }
  } else throw new OperatorSessionError();
  return user.id;
}
