import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Business, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { getContext } from '../../common/context/request-context';
import {
  NotFoundError,
  OwnerSuspendedError,
  UnauthorizedError,
} from '../../common/errors/api-errors';
import { PairDto } from './dto/pair.dto';

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface OwnerSession {
  token: string;
  email: string;
  ownerName: string;
}

export interface BusinessListItem {
  id: string;
  name: string;
  type: Business['type'];
  isDemo: boolean;
}

export interface BranchInfo {
  id: string;
  name: string;
  code: string;
  address: string;
}

export interface BusinessSettings {
  id: string;
  name: string;
  type: Business['type'];
  currency: string;
  taxRate: number;
  serviceChargeRate: number;
  allowMiscItems: boolean;
  dayStartTime: string;
  expiryWarningDays: number;
  receiptHeader: string;
  receiptFooter: string;
  isDemo: boolean;
}

export interface PairResult {
  deviceToken: string;
  business: BusinessSettings;
  branch: BranchInfo;
  terminalName: string;
  terminalCode: string;
  receiptSeq: number;
}

function serializeBusinessSettings(b: Business): BusinessSettings {
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    currency: b.currency,
    taxRate: b.taxRate.toNumber(),
    serviceChargeRate: b.serviceChargeRate.toNumber(),
    allowMiscItems: b.allowMiscItems,
    dayStartTime: b.dayStartTime,
    expiryWarningDays: b.expiryWarningDays,
    receiptHeader: b.receiptHeader,
    receiptFooter: b.receiptFooter,
    isDemo: b.isDemo,
  };
}

/**
 * Task 16 — POS terminal pairing. Owner-only, pre-tenant flow: everything runs
 * on the RAW client filtered by the ownerId carried in the pairing token. Device
 * tokens are 32-byte secrets stored only as a sha256 hash; terminal codes are
 * "T"+n where n counts terminals EVER created for the branch (incl. soft-deleted,
 * so codes are never reused). Pair/unpair write explicit `terminal.*` audit rows.
 */
@Injectable()
export class PairingService {
  constructor(
    private readonly raw: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async signIn(email: string, password: string): Promise<OwnerSession> {
    const { user, owner } = await this.auth.verifyOwnerCredentials(
      email,
      password,
      'auth.pairing_signin_failed',
    );
    // Sign-in requires an ACTIVE owner (any suspension rejects; the grace path
    // lives only in TerminalGuard for an already-paired terminal).
    if (owner.status !== 'active') {
      throw new OwnerSuspendedError();
    }
    const token = this.auth.mintPairingToken(user.id, owner.id);
    await this.audit('auth.pairing_signin', {
      actorId: user.id,
      ownerId: owner.id,
      entityType: 'user',
      entityId: user.id,
    });
    return { token, email: user.email, ownerName: owner.name };
  }

  async businesses(ownerId: string): Promise<BusinessListItem[]> {
    const rows = await this.raw.business.findMany({
      where: { ownerId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      isDemo: b.isDemo,
    }));
  }

  async branches(ownerId: string, businessId: string): Promise<BranchInfo[]> {
    await this.ownedBusiness(ownerId, businessId);
    const rows = await this.raw.branch.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((br) => ({
      id: br.id,
      name: br.name,
      code: br.code,
      address: br.address,
    }));
  }

  async pair(
    ownerId: string,
    ownerUserId: string,
    dto: PairDto,
  ): Promise<PairResult> {
    const business = await this.ownedBusiness(ownerId, dto.businessId);
    const branch = await this.raw.branch.findFirst({
      where: { id: dto.branchId, businessId: business.id, deletedAt: null },
    });
    if (!branch) throw new NotFoundError('Branch not found.');

    const owner = await this.raw.owner.findUniqueOrThrow({
      where: { id: ownerId },
    });
    if (owner.status !== 'active') throw new OwnerSuspendedError();

    const deviceToken = randomBytes(32).toString('hex');
    const deviceTokenHash = sha256(deviceToken);

    // Codes are never reused: count ALL terminals ever created for the branch
    // (including soft-deleted), then n = count + 1. Two concurrent pairs can
    // compute the same n and collide on @@unique([branchId, code]) — retry a few
    // times, recomputing the count (now higher) into the next free code.
    let terminal;
    for (let attempt = 0; ; attempt++) {
      const priorCount = await this.raw.terminal.count({
        where: { branchId: branch.id },
      });
      try {
        terminal = await this.raw.terminal.create({
          data: {
            branchId: branch.id,
            name: dto.terminalName,
            code: `T${priorCount + 1}`,
            deviceTokenHash,
          },
        });
        break;
      } catch (err) {
        if (
          attempt < 3 &&
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }

    await this.audit('terminal.pair', {
      actorId: ownerUserId,
      ownerId,
      businessId: business.id,
      branchId: branch.id,
      entityType: 'terminal',
      entityId: terminal.id,
      changes: {
        after: {
          id: terminal.id,
          branchId: terminal.branchId,
          name: terminal.name,
          code: terminal.code,
          receiptSeq: terminal.receiptSeq,
        },
      },
      meta: { terminalCode: terminal.code },
    });

    return {
      deviceToken,
      business: serializeBusinessSettings(business),
      branch: {
        id: branch.id,
        name: branch.name,
        code: branch.code,
        address: branch.address,
      },
      terminalName: terminal.name,
      terminalCode: terminal.code,
      receiptSeq: terminal.receiptSeq,
    };
  }

  async unpair(
    deviceToken: string,
    email: string,
    password: string,
  ): Promise<{ ok: true }> {
    const terminal = await this.raw.terminal.findFirst({
      where: { deviceTokenHash: sha256(deviceToken), deletedAt: null },
      include: { branch: { select: { businessId: true } } },
    });
    if (!terminal) throw new UnauthorizedError();

    // Owner re-auth (suspension NOT gated — a device must be offboardable).
    const { user, owner } = await this.auth.verifyOwnerCredentials(
      email,
      password,
      'auth.unpair_failed',
    );

    // The re-authed owner must own this terminal.
    const business = await this.raw.business.findUniqueOrThrow({
      where: { id: terminal.branch.businessId },
      select: { ownerId: true },
    });
    if (owner.id !== business.ownerId) throw new UnauthorizedError();

    await this.raw.terminal.update({
      where: { id: terminal.id },
      data: { deviceTokenHash: null },
    });

    await this.audit('terminal.unpair', {
      actorId: user.id,
      ownerId: owner.id,
      businessId: terminal.branch.businessId,
      branchId: terminal.branchId,
      entityType: 'terminal',
      entityId: terminal.id,
      meta: { terminalCode: terminal.code },
    });

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async ownedBusiness(
    ownerId: string,
    businessId: string,
  ): Promise<Business> {
    const business = await this.raw.business.findFirst({
      where: { id: businessId, ownerId, deletedAt: null },
    });
    if (!business) throw new NotFoundError('Business not found.');
    return business;
  }

  /**
   * Explicit audit row on the raw client — pairing is a pre-tenant flow with no
   * scoped-client auto-audit, and the actor is the OWNER (from the pairing token
   * / re-auth), not a RequestContext actor.
   */
  private async audit(
    action: string,
    opts: {
      actorId: string;
      ownerId: string;
      businessId?: string | null;
      branchId?: string | null;
      entityType: string;
      entityId: string;
      changes?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    },
  ): Promise<void> {
    let ctx: {
      requestId?: string;
      ip?: string;
      userAgent?: string;
      sessionId?: string | null;
    } = {};
    try {
      ctx = getContext();
    } catch {
      // outside a request scope (e.g. unit tests)
    }
    await this.raw.auditLog.create({
      data: {
        actorType: 'owner',
        actorId: opts.actorId,
        ownerId: opts.ownerId,
        businessId: opts.businessId ?? null,
        branchId: opts.branchId ?? null,
        action,
        entityType: opts.entityType,
        entityId: opts.entityId,
        changes: (opts.changes ?? {}) as Prisma.InputJsonValue,
        metadata: {
          requestId: ctx.requestId ?? null,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          sessionId: ctx.sessionId ?? null,
          ...(opts.meta ?? {}),
        },
      },
    });
  }
}
