import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../auth/audit.service';
import { getContext } from '../../common/context/request-context';
import { ForbiddenError } from '../../common/errors/api-errors';
import { hashSecret } from '../../auth/hashing';

/**
 * Task 14 — portal settings. The refund PIN lives on the platform `users` model
 * (`pin_hash`), which is OUTSIDE the tenancy choke point, so this writes on the
 * RAW client and audits the change explicitly (the auto write-through does not
 * cover platform-model writes). The PIN value is never logged.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly raw: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async setRefundPin(pin: string): Promise<{ ok: true }> {
    const { actor, ownerId } = getContext();
    if (!actor || !ownerId) {
      throw new ForbiddenError('Portal access requires an owner account.');
    }

    const pinHash = await hashSecret(pin);
    // Set on the authenticated owner user; a fresh PIN clears that user's own
    // PIN lockout (other owner-role users, if any, are unaffected).
    await this.raw.user.update({
      where: { id: actor.id },
      data: { pinHash, failedPinCount: 0, pinLockedUntil: null },
    });

    // §11 — audit the change with NO value.
    await this.audit.logAuth('user.refund_pin_set', actor.id, ownerId);

    return { ok: true };
  }
}
