import { Inject, Injectable } from '@nestjs/common';
import { Terminal } from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import { NotFoundError } from '../../common/errors/api-errors';
import { assertBusinessOwned } from '../shared/tenant-guards';

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
  constructor(@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma) {}

  async list(businessId: string): Promise<TerminalResponse[]> {
    await assertBusinessOwned(this.scoped, businessId);
    const rows = await this.scoped.terminal.findMany({
      where: { branch: { businessId } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(serializeTerminal);
  }

  async unpair(id: string): Promise<TerminalResponse> {
    const existing = await this.scoped.terminal.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('Terminal not found.');
    const updated = await this.scoped.terminal.update({
      where: { id },
      data: { deviceTokenHash: null },
    });
    return serializeTerminal(updated);
  }
}
