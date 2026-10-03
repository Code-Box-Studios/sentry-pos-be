import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, StaffChallengeKind } from '@prisma/client';
import { AuditService } from '../auth/audit.service';
import {
  EmailTakenError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../common/errors/api-errors';
import { getContext } from '../common/context/request-context';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffChallengeService } from './staff-challenge.service';
import { CreateStaffDto, UpdateStaffDto } from './dto/staff.dto';

type StaffRow = Prisma.StaffProfileGetPayload<{
  include: { user: true; branches: true };
}>;

export interface StaffView {
  id: string;
  userId: string;
  name: string;
  role: 'manager' | 'cashier';
  email: string | null;
  status: 'pending' | 'active' | 'deactivated';
  branchIds: string[];
  createdAt: string;
}

function view(row: StaffRow): StaffView {
  if (row.user.role !== 'manager' && row.user.role !== 'cashier') {
    throw new Error('Staff profile has an invalid user role.');
  }
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    role: row.user.role,
    email: row.user.email,
    status: row.status,
    branchIds: row.branches
      .filter((branch) => !branch.deletedAt)
      .map((branch) => branch.branchId),
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class StaffService {
  constructor(
    private readonly raw: PrismaService,
    private readonly challenges: StaffChallengeService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private async assertOwner(businessId: string): Promise<void> {
    const ctx = getContext();
    if (ctx.actor?.type !== 'owner' || !ctx.ownerId) {
      throw new ForbiddenError('Only a business owner can manage staff.');
    }
    const business = await this.raw.business.findFirst({
      where: { id: businessId, ownerId: ctx.ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!business) throw new NotFoundError('Business not found.');
  }

  private async assertBranches(
    tx: Prisma.TransactionClient,
    businessId: string,
    branchIds: string[],
  ): Promise<string[]> {
    const unique = [...new Set(branchIds)];
    if (unique.length === 0) {
      throw new ValidationFailedError('Assign at least one branch.');
    }
    const branches = await tx.branch.findMany({
      where: { id: { in: unique }, businessId, deletedAt: null },
      select: { id: true },
    });
    if (branches.length !== unique.length) {
      throw new ValidationFailedError(
        'Every assigned branch must belong to this business.',
      );
    }
    return unique;
  }

  private async managedProfile(
    tx: Prisma.TransactionClient,
    businessId: string,
    userId: string,
  ): Promise<StaffRow> {
    const row = await tx.staffProfile.findFirst({
      where: { businessId, userId, deletedAt: null },
      include: { user: true, branches: true },
    });
    if (!row) throw new NotFoundError('Staff member not found.');
    return row;
  }

  private async lockUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    // Operator unlock uses this same row lock before its final eligibility check
    // and session insert, so revocation cannot race a newly issued session.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  }

  private async revoke(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const now = new Date();
    await tx.operatorSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async sendPin(
    email: string,
    pin: string,
    kind: StaffChallengeKind = 'manager_setup',
  ): Promise<void> {
    const path =
      kind === 'password_reset' ? '/login/staff?mode=password' : '/login/staff';
    const link = new URL(
      path,
      this.config.get<string>('APP_URL') ?? 'http://localhost:3000',
    ).href;
    const instruction =
      kind === 'pin_reset'
        ? '<p>At your assigned terminal, select your name and use this PIN to choose a new terminal PIN.</p>'
        : `<p><a href="${link}">Set up your ${kind === 'password_reset' ? 'new portal password' : 'staff access'}</a>.</p>`;
    await this.mail.send({
      to: email,
      subject: 'Your temporary Sentry POS PIN',
      html:
        `<p>Your one-time setup PIN is <strong>${pin}</strong>.</p>` +
        '<p>It expires in 15 minutes. Change it before using Sentry POS.</p>' +
        instruction,
    });
  }

  async list(businessId: string): Promise<StaffView[]> {
    await this.assertOwner(businessId);
    const rows = await this.raw.staffProfile.findMany({
      where: { businessId, deletedAt: null },
      include: { user: true, branches: true },
      orderBy: { createdAt: 'asc' },
    });
    await this.audit.logPortal(
      'staff.list_read',
      'business',
      businessId,
      businessId,
    );
    return rows.map(view);
  }

  async create(
    businessId: string,
    dto: CreateStaffDto,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    await this.assertOwner(businessId);
    const name = dto.name.trim();
    const email = dto.email?.trim().toLowerCase() || null;
    if (!name) throw new ValidationFailedError('Name is required.');
    if (dto.role === 'manager' && !email) {
      throw new ValidationFailedError('A manager needs an email address.');
    }

    let created: { staff: StaffView; pin: string };
    try {
      created = await this.raw.$transaction(async (tx) => {
        const branchIds = await this.assertBranches(
          tx,
          businessId,
          dto.branchIds,
        );
        const user = await tx.user.create({
          data: { role: dto.role, ownerId: getContext().ownerId!, email },
        });
        const row = await tx.staffProfile.create({
          data: {
            userId: user.id,
            businessId,
            name,
            branches: { create: branchIds.map((branchId) => ({ branchId })) },
          },
          include: { user: true, branches: true },
        });
        const pin = await this.challenges.issue(
          tx,
          user.id,
          dto.role === 'manager' ? 'manager_setup' : 'cashier_setup',
        );
        await this.audit.logPortal(
          'staff.created',
          'staffProfile',
          row.id,
          businessId,
          { role: dto.role, branchIds },
          tx,
        );
        return { staff: view(row), pin };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new EmailTakenError();
      throw error;
    }

    if (dto.role === 'manager') {
      await this.sendPin(email!, created.pin);
      return { staff: created.staff };
    }
    return { staff: created.staff, temporaryPin: created.pin };
  }

  async update(
    businessId: string,
    userId: string,
    dto: UpdateStaffDto,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    await this.assertOwner(businessId);
    const result = await this.raw
      .$transaction(async (tx) => {
        await this.lockUser(tx, userId);
        const before = await this.managedProfile(tx, businessId, userId);
        const role = dto.role ?? before.user.role;
        if (role !== 'manager' && role !== 'cashier') {
          throw new ValidationFailedError('Invalid staff role.');
        }
        const email =
          dto.email === undefined
            ? before.user.email
            : dto.email.trim().toLowerCase();
        if (role === 'manager' && !email) {
          throw new ValidationFailedError('A manager needs an email address.');
        }
        const name = dto.name === undefined ? before.name : dto.name.trim();
        if (!name) throw new ValidationFailedError('Name is required.');
        const branchIds =
          dto.branchIds === undefined
            ? before.branches
                .filter((branch) => !branch.deletedAt)
                .map((branch) => branch.branchId)
            : await this.assertBranches(tx, businessId, dto.branchIds);
        if (branchIds.length === 0) {
          throw new ValidationFailedError('Assign at least one branch.');
        }

        const roleChanged = role !== before.user.role;
        const emailChanged = email !== before.user.email;
        await tx.user.update({
          where: { id: userId },
          data: {
            role,
            email,
            ...(roleChanged ? { passwordHash: null, pinHash: null } : {}),
          },
        });
        await tx.staffProfile.update({
          where: { id: before.id },
          data: {
            name,
            ...(roleChanged ? { status: 'pending' } : {}),
            branches: {
              deleteMany: {},
              create: branchIds.map((branchId) => ({ branchId })),
            },
          },
        });
        if (roleChanged || emailChanged || dto.branchIds !== undefined) {
          await this.revoke(tx, userId);
        }
        let pin: string | undefined;
        if (roleChanged) {
          pin = await this.challenges.issue(
            tx,
            userId,
            role === 'manager' ? 'manager_setup' : 'cashier_setup',
          );
        }
        await this.audit.logPortal(
          'staff.updated',
          'staffProfile',
          before.id,
          businessId,
          {
            role,
            branchIds,
            roleChanged,
            emailChanged,
          },
          tx,
        );
        return {
          staff: view(await this.managedProfile(tx, businessId, userId)),
          pin,
        };
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new EmailTakenError();
        }
        throw error;
      });
    if (result.pin && result.staff.role === 'manager') {
      await this.sendPin(result.staff.email!, result.pin);
    }
    return result.pin && result.staff.role === 'cashier'
      ? { staff: result.staff, temporaryPin: result.pin }
      : { staff: result.staff };
  }

  private async issueReset(
    businessId: string,
    userId: string,
    kind: StaffChallengeKind,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    await this.assertOwner(businessId);
    const result = await this.raw.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const before = await this.managedProfile(tx, businessId, userId);
      if (before.status === 'deactivated') {
        throw new ValidationFailedError(
          'Reactivate this staff member before resetting credentials.',
        );
      }
      if (kind === 'password_reset' && before.user.role !== 'manager') {
        throw new ValidationFailedError('Only managers have portal passwords.');
      }
      const effectiveKind: StaffChallengeKind =
        before.user.role === 'manager' &&
        (!before.user.passwordHash || !before.user.pinHash)
          ? 'manager_setup'
          : kind;
      await tx.user.update({
        where: { id: userId },
        data:
          effectiveKind === 'manager_setup'
            ? {
                passwordHash: null,
                pinHash: null,
                failedPinCount: 0,
                pinLockedUntil: null,
              }
            : effectiveKind === 'password_reset'
              ? { passwordHash: null }
              : { pinHash: null, failedPinCount: 0, pinLockedUntil: null },
      });
      await tx.staffProfile.update({
        where: { id: before.id },
        data: { status: 'pending' },
      });
      await this.revoke(tx, userId);
      const pin = await this.challenges.issue(tx, userId, effectiveKind);
      await this.audit.logPortal(
        'staff.credential_reset',
        'staffProfile',
        before.id,
        businessId,
        {
          kind: effectiveKind,
        },
        tx,
      );
      return {
        staff: view(await this.managedProfile(tx, businessId, userId)),
        pin,
        kind: effectiveKind,
      };
    });
    if (result.staff.role === 'manager') {
      await this.sendPin(result.staff.email!, result.pin, result.kind);
      return { staff: result.staff };
    }
    return { staff: result.staff, temporaryPin: result.pin };
  }

  resetPin(businessId: string, userId: string) {
    return this.issueReset(businessId, userId, 'pin_reset');
  }

  resetPassword(businessId: string, userId: string) {
    return this.issueReset(businessId, userId, 'password_reset');
  }

  async resend(businessId: string, userId: string) {
    await this.assertOwner(businessId);
    const row = await this.raw.staffProfile.findFirst({
      where: { businessId, userId, deletedAt: null },
      include: { user: true },
    });
    if (!row) throw new NotFoundError('Staff member not found.');
    if (row.status !== 'pending') {
      throw new ValidationFailedError(
        'Only pending staff can receive a new temporary PIN.',
      );
    }
    const kind: StaffChallengeKind =
      row.user.role === 'cashier'
        ? row.user.pinHash
          ? 'pin_reset'
          : 'cashier_setup'
        : row.user.passwordHash
          ? 'pin_reset'
          : row.user.pinHash
            ? 'password_reset'
            : 'manager_setup';
    const result = await this.raw.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const pin = await this.challenges.issue(tx, userId, kind);
      await this.audit.logPortal(
        'staff.temporary_pin_resent',
        'staffProfile',
        row.id,
        businessId,
        { kind },
        tx,
      );
      return pin;
    });
    if (row.user.role === 'manager') {
      await this.sendPin(row.user.email!, result, kind);
      return { staff: await this.get(businessId, userId) };
    }
    return { staff: await this.get(businessId, userId), temporaryPin: result };
  }

  async deactivate(businessId: string, userId: string): Promise<StaffView> {
    await this.assertOwner(businessId);
    return this.raw.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const before = await this.managedProfile(tx, businessId, userId);
      await tx.staffProfile.update({
        where: { id: before.id },
        data: { status: 'deactivated' },
      });
      await this.revoke(tx, userId);
      await tx.staffChallenge.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await this.audit.logPortal(
        'staff.deactivated',
        'staffProfile',
        before.id,
        businessId,
        {},
        tx,
      );
      return view(await this.managedProfile(tx, businessId, userId));
    });
  }

  async reactivate(
    businessId: string,
    userId: string,
  ): Promise<{ staff: StaffView; temporaryPin?: string }> {
    await this.assertOwner(businessId);
    const result = await this.raw.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const before = await this.managedProfile(tx, businessId, userId);
      if (before.status !== 'deactivated') {
        throw new ValidationFailedError(
          'Only deactivated staff can be reactivated.',
        );
      }
      const canActivate =
        Boolean(before.user.pinHash) &&
        (before.user.role === 'cashier' || Boolean(before.user.passwordHash));
      const kind =
        before.user.role === 'manager' ? 'manager_setup' : 'cashier_setup';
      const pin = canActivate
        ? undefined
        : await this.challenges.issue(tx, userId, kind);
      await tx.staffProfile.update({
        where: { id: before.id },
        data: { status: canActivate ? 'active' : 'pending' },
      });
      await this.audit.logPortal(
        'staff.reactivated',
        'staffProfile',
        before.id,
        businessId,
        {},
        tx,
      );
      return {
        staff: view(await this.managedProfile(tx, businessId, userId)),
        pin,
      };
    });
    if (result.pin && result.staff.role === 'manager') {
      await this.sendPin(result.staff.email!, result.pin);
    }
    return result.pin && result.staff.role === 'cashier'
      ? { staff: result.staff, temporaryPin: result.pin }
      : { staff: result.staff };
  }

  async get(businessId: string, userId: string): Promise<StaffView> {
    await this.assertOwner(businessId);
    const row = await this.raw.staffProfile.findFirst({
      where: { businessId, userId, deletedAt: null },
      include: { user: true, branches: true },
    });
    if (!row) throw new NotFoundError('Staff member not found.');
    return view(row);
  }
}
