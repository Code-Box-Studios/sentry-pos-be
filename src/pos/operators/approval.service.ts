import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  getContext,
  setAuthContext,
} from '../../common/context/request-context';
import {
  ForbiddenError,
  UnauthorizedError,
} from '../../common/errors/api-errors';
import { LockoutService } from '../../common/lockout/lockout.service';
import { PrismaService } from '../../prisma/prisma.service';
import { permissionFor, type StaffAction } from '../../staff/staff-policy';
import { ApprovalDto } from './dto/approval.dto';

@Injectable()
export class ApprovalService {
  constructor(
    private readonly raw: PrismaService,
    private readonly lockout: LockoutService,
  ) {}

  private async eligible(
    db: PrismaService | Prisma.TransactionClient,
    userId: string,
  ): Promise<'owner' | 'manager'> {
    const ctx = getContext();
    const user = await db.user.findUnique({
      where: { id: userId },
      include: { owner: true, staffProfile: { include: { branches: true } } },
    });
    if (!user || user.deletedAt || user.ownerId !== ctx.ownerId) {
      throw new ForbiddenError(
        'An assigned manager or owner must approve this action.',
      );
    }
    if (
      user.role === 'owner' &&
      user.owner &&
      !user.owner.deletedAt &&
      user.owner.status !== 'hard_suspended' &&
      user.owner.status !== 'closed'
    )
      return 'owner';
    if (
      user.role === 'manager' &&
      user.staffProfile &&
      !user.staffProfile.deletedAt &&
      user.staffProfile.status === 'active' &&
      user.staffProfile.businessId === ctx.businessId &&
      user.staffProfile.branches.some(
        (b) => b.branchId === ctx.branchId && !b.deletedAt,
      )
    )
      return 'manager';
    throw new ForbiddenError(
      'An assigned manager or owner must approve this action.',
    );
  }

  async authorize(
    action: Extract<
      StaffAction,
      'terminal_void' | 'terminal_refund' | 'terminal_stock_adjust'
    >,
    ownPin?: string,
    approval?: ApprovalDto,
  ): Promise<string | null> {
    const operator = getContext().operator;
    if (!operator)
      throw new UnauthorizedError('Unlock this terminal to continue.');
    const permission = permissionFor(operator.role, action);
    if (permission === 'deny') throw new ForbiddenError();
    if (permission === 'allow') return null;
    if (permission === 'self_pin') {
      if (!ownPin) throw new ForbiddenError('Your PIN is required.');
      const role = await this.eligible(this.raw, operator.userId);
      const pinHash = await this.lockout.verifyUserPin(operator.userId, ownPin);
      setAuthContext({
        approvalActor: { userId: operator.userId, role, pinHash },
      });
      return operator.userId;
    }
    if (!approval || approval.approverUserId === operator.userId) {
      throw new ForbiddenError(
        'An assigned manager or owner must approve this action.',
      );
    }
    const role = await this.eligible(this.raw, approval.approverUserId);
    const pinHash = await this.lockout.verifyUserPin(
      approval.approverUserId,
      approval.pin,
    );
    setAuthContext({
      approvalActor: { userId: approval.approverUserId, role, pinHash },
    });
    return approval.approverUserId;
  }

  /** One-action authority for recovering a drawer, never an operator session. */
  async authorizeEmergency(approval: ApprovalDto): Promise<string> {
    const role = await this.eligible(this.raw, approval.approverUserId);
    const pinHash = await this.lockout.verifyUserPin(
      approval.approverUserId,
      approval.pin,
    );
    setAuthContext({
      approvalActor: { userId: approval.approverUserId, role, pinHash },
    });
    return approval.approverUserId;
  }

  async assertApproverWrite(
    tx: Prisma.TransactionClient,
    userId: string | null,
  ): Promise<void> {
    if (!userId) return;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const role = await this.eligible(tx, userId);
    const proof = getContext().approvalActor;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { pinHash: true },
    });
    if (
      !proof ||
      proof.userId !== userId ||
      proof.role !== role ||
      user?.pinHash !== proof.pinHash
    ) {
      throw new ForbiddenError(
        'Approval expired. Ask the approver to enter their current PIN.',
      );
    }
  }
}
