import { Injectable } from '@nestjs/common';
import { Owner, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InviteService } from '../auth/invite.service';
import { AuditService } from '../auth/audit.service';
import { EmailTakenError, NotFoundError } from '../common/errors/api-errors';
import { CreateOwnerDto } from './dto/create-owner.dto';
import { UpdateOwnerDto } from './dto/update-owner.dto';
import { SuspendOwnerDto } from './dto/suspend-owner.dto';

/**
 * Task 10 — platform-admin owner provisioning + two-tier suspension.
 *
 * Owner and User are PLATFORM models, so every write here runs on the RAW
 * `PrismaService`: the tenancy choke point (Task 4) forbids platform-scope
 * writes to tenant tables, and platform models are outside its tenant map
 * entirely. Every mutation is recorded via `AuditService.logAdmin` (§11) —
 * `actorType: platform_admin`, `businessId: null` — so admin actions are audited
 * but never surface in a BO's tenant-scope activity log (Task 4 rule 2).
 */
@Injectable()
export class OwnersService {
  constructor(
    private readonly raw: PrismaService,
    private readonly invites: InviteService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<Owner[]> {
    return this.raw.owner.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string): Promise<Owner> {
    const owner = await this.raw.owner.findFirst({
      where: { id, deletedAt: null },
    });
    if (!owner) throw new NotFoundError('Owner not found.');
    return owner;
  }

  /**
   * Provision an owner + its (password-less) owner user, then invite.
   *
   * Owner + user are created in a single `$transaction` so a failed user insert
   * (e.g. duplicate email) never strands a half-created owner. The invite —
   * token mint + email, a side effect — runs AFTER the tx commits: a rolled-back
   * transaction never emails, and a mail failure can't undo the committed rows
   * (the invite is simply re-sendable). The user has NO password until the
   * invite is accepted (Task 9's `acceptInvite` sets it).
   */
  async create(dto: CreateOwnerDto): Promise<Owner> {
    const { owner, user } = await this.raw
      .$transaction(async (tx) => {
        const owner = await tx.owner.create({
          data: {
            name: dto.name,
            email: dto.email,
            maxBusinesses: dto.maxBusinesses,
            status: 'active',
          },
        });
        const user = await tx.user.create({
          data: {
            email: dto.email,
            role: 'owner',
            ownerId: owner.id,
            // passwordHash intentionally omitted (null) — set on invite accept.
          },
        });
        return { owner, user };
      })
      .catch((err: unknown) => {
        // owner.email / user.email are @unique — surface a duplicate as a clean
        // 409 rather than an unhandled 500. The tx has already rolled back.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new EmailTakenError();
        }
        throw err;
      });

    await this.invites.createInvite(user.id);

    await this.audit.logAdmin('admin.owner.create', 'owner', owner.id, {
      after: {
        name: owner.name,
        email: owner.email,
        maxBusinesses: owner.maxBusinesses,
      },
    });

    return owner;
  }

  async update(id: string, dto: UpdateOwnerDto): Promise<Owner> {
    const before = await this.get(id);
    const owner = await this.raw.owner.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.maxBusinesses !== undefined
          ? { maxBusinesses: dto.maxBusinesses }
          : {}),
      },
    });

    await this.audit.logAdmin('admin.owner.update', 'owner', id, {
      before: { name: before.name, maxBusinesses: before.maxBusinesses },
      after: { name: owner.name, maxBusinesses: owner.maxBusinesses },
    });

    return owner;
  }

  /**
   * Two-tier suspend (§8):
   * - `default` → `suspended` (portal locked; open shifts may finish selling
   *   ≤ 24h — the terminal-side grace check is Task 16).
   * - `hard` → `hard_suspended` (everything dies instantly).
   */
  async suspend(id: string, dto: SuspendOwnerDto): Promise<Owner> {
    await this.get(id); // 404 before we attempt the write
    const owner = await this.raw.owner.update({
      where: { id },
      data: {
        status: dto.tier === 'hard' ? 'hard_suspended' : 'suspended',
        suspendedAt: new Date(),
      },
    });

    await this.audit.logAdmin('admin.owner.suspend', 'owner', id, {
      tier: dto.tier,
      status: owner.status,
    });

    return owner;
  }

  async reinstate(id: string): Promise<Owner> {
    await this.get(id);
    const owner = await this.raw.owner.update({
      where: { id },
      data: { status: 'active', suspendedAt: null },
    });

    await this.audit.logAdmin('admin.owner.reinstate', 'owner', id, {
      status: 'active',
    });

    return owner;
  }
}
