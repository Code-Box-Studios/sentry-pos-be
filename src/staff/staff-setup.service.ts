import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../auth/audit.service';
import { AuthService } from '../auth/auth.service';
import { hashSecret } from '../auth/hashing';
import {
  InvalidTokenError,
  ValidationFailedError,
} from '../common/errors/api-errors';
import { PrismaService } from '../prisma/prisma.service';
import { SetupManagerDto, SetupPasswordDto } from './dto/staff.dto';
import { StaffChallengeService } from './staff-challenge.service';

@Injectable()
export class StaffSetupService {
  constructor(
    private readonly raw: PrismaService,
    private readonly challenges: StaffChallengeService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  private async manager(email: string) {
    const user = await this.raw.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { staffProfile: true },
    });
    if (
      !user ||
      user.deletedAt ||
      user.role !== 'manager' ||
      !user.ownerId ||
      !user.staffProfile ||
      user.staffProfile.deletedAt ||
      user.staffProfile.status !== 'pending'
    ) {
      return null;
    }
    return user;
  }

  async setupManager(dto: SetupManagerDto): Promise<{
    accessToken: string;
    refreshToken: string;
    role: 'manager';
  }> {
    if (dto.permanentPin === dto.temporaryPin) {
      throw new ValidationFailedError(
        'Choose a new PIN different from the temporary PIN.',
      );
    }
    const user = await this.manager(dto.email);
    if (!user) return this.challenges.rejectUnknown(dto.temporaryPin);
    const passwordHash = await hashSecret(dto.password);
    const pinHash = await hashSecret(dto.permanentPin);
    await this.challenges.consume(
      user.id,
      'manager_setup',
      dto.temporaryPin,
      async (tx: Prisma.TransactionClient) => {
        const profile = await tx.staffProfile.findUnique({
          where: { userId: user.id },
        });
        if (!profile || profile.status !== 'pending')
          throw new InvalidTokenError();
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, pinHash },
        });
        await tx.staffProfile.update({
          where: { id: profile.id },
          data: { status: 'active' },
        });
        await this.audit.logAuth(
          'staff.manager_setup',
          user.id,
          user.ownerId,
          {},
          tx,
          'staff',
        );
      },
    );
    const tokens = await this.auth.mintTokenPair(
      user.id,
      'manager',
      user.ownerId!,
    );
    return { ...tokens, role: 'manager' };
  }

  async setupPassword(dto: SetupPasswordDto): Promise<{
    accessToken: string;
    refreshToken: string;
    role: 'manager';
  }> {
    const user = await this.manager(dto.email);
    if (!user || !user.pinHash)
      return this.challenges.rejectUnknown(dto.temporaryPin);
    const passwordHash = await hashSecret(dto.password);
    await this.challenges.consume(
      user.id,
      'password_reset',
      dto.temporaryPin,
      async (tx: Prisma.TransactionClient) => {
        const profile = await tx.staffProfile.findUnique({
          where: { userId: user.id },
        });
        if (!profile || profile.status !== 'pending')
          throw new InvalidTokenError();
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash },
        });
        await tx.staffProfile.update({
          where: { id: profile.id },
          data: { status: 'active' },
        });
        await this.audit.logAuth(
          'staff.password_setup',
          user.id,
          user.ownerId,
          {},
          tx,
          'staff',
        );
      },
    );
    const tokens = await this.auth.mintTokenPair(
      user.id,
      'manager',
      user.ownerId!,
    );
    return { ...tokens, role: 'manager' };
  }
}
