import { PrismaService } from '../../prisma/prisma.service';
import { hashSecret } from '../../auth/hashing';
import { LockoutService } from './lockout.service';

describe('owner PIN verification with staff identities present', () => {
  it('uses the owner user rather than the first staff user under that owner', async () => {
    const users = [
      {
        id: 'staff-user',
        ownerId: 'owner-1',
        role: 'manager',
        deletedAt: null,
        pinHash: await hashSecret('654321'),
        pinLockedUntil: null,
        failedPinCount: 0,
      },
      {
        id: 'owner-user',
        ownerId: 'owner-1',
        role: 'owner',
        deletedAt: null,
        pinHash: await hashSecret('123456'),
        pinLockedUntil: null,
        failedPinCount: 0,
      },
    ];
    const raw = {
      user: {
        findFirst: jest
          .fn()
          .mockImplementation(
            ({
              where,
            }: {
              where: { ownerId: string; deletedAt: null; role?: string };
            }) =>
              users.find(
                (user) =>
                  user.ownerId === where.ownerId &&
                  user.deletedAt === where.deletedAt &&
                  (where.role === undefined || user.role === where.role),
              ),
          ),
        findUniqueOrThrow: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            users.find((user) => user.id === where.id),
          ),
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            users.find((user) => user.id === where.id),
          ),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as unknown as PrismaService;
    raw.$transaction = jest
      .fn()
      .mockImplementation((fn: (tx: PrismaService) => Promise<void>) =>
        fn(raw),
      );
    const service = new LockoutService(raw);
    await expect(
      service.verifyPinWithLockout('owner-1', '123456'),
    ).resolves.toBeUndefined();
  });
});
