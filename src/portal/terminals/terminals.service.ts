import { Inject, Injectable } from '@nestjs/common';
import { Terminal } from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import { NotFoundError } from '../../common/errors/api-errors';
import { assertBusinessOwned } from '../shared/tenant-guards';
import {
  getContext,
  runWithTxClient,
} from '../../common/context/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { assertManagerWrite } from '../../staff/manager-write';

export interface TerminalResponse {
  id: string;
  branchId: string;
  name: string;
  code: string;
  pairedAt: Date;
  lastSeenAt: Date | null;
  paired: boolean;
}

/** Never expose deviceTokenHash; surface a `paired` boolean instead. */
function serializeTerminal(t: Terminal): TerminalResponse {
  return {
    id: t.id,
    branchId: t.branchId,
    name: t.name,
    code: t.code,
    pairedAt: t.createdAt,
    lastSeenAt: t.lastSeenAt,
    paired: t.deviceTokenHash !== null,
  };
}

/**
 * Task 14 — portal terminals (tenant scope). List a business's terminals and
 * remotely unpair one by nulling its device token (the device 401s on its next
 * request, §8). All access flows through the ScopedPrisma choke point (terminals
 * are branch-scoped to the owner; unpair is auto-audited as terminal.update).
 */
@Injectable()
export class TerminalsService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
  ) {}

  async list(businessId: string): Promise<TerminalResponse[]> {
    await assertBusinessOwned(this.scoped, businessId);
    const ctx = getContext();
    const rows = await this.scoped.terminal.findMany({
      where: {
        branch: { businessId },
        ...(ctx.actor?.type === 'staff'
          ? { branchId: { in: ctx.managerBranchIds ?? [] } }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(serializeTerminal);
  }

  async unpair(id: string): Promise<TerminalResponse> {
    return this.raw.$transaction((tx) =>
      runWithTxClient(tx, async () => {
        await tx.$queryRaw`SELECT id FROM terminals WHERE id = ${id}::uuid FOR UPDATE`;
        const existing = await this.scoped.terminal.findFirst({
          where: { id },
          include: { branch: { select: { businessId: true } } },
        });
        if (!existing) throw new NotFoundError('Terminal not found.');
        await assertManagerWrite(
          tx,
          existing.branch.businessId,
          existing.branchId,
        );
        const updated = await this.scoped.terminal.update({
          where: { id },
          data: { deviceTokenHash: null },
        });
        await tx.operatorSession.updateMany({
          where: { terminalId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return serializeTerminal(updated);
      }),
    );
  }
}
