import { Provider } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { createScopedPrisma } from './scoped-prisma';

/**
 * Injection token for the tenancy/audit-enforcing scoped Prisma client (Task 4).
 *
 * Business modules inject `SCOPED_PRISMA` — NEVER the raw `PrismaService`.
 * The raw client stays reserved for auth/system/seed/platform-audit paths that
 * must bypass tenant scoping (Tasks 6–10).
 */
export const SCOPED_PRISMA = Symbol('SCOPED_PRISMA');

/** The type of the extended client, for typed injection at call sites. */
export type ScopedPrisma = ReturnType<typeof createScopedPrisma>;

/**
 * Factory provider that builds the `$extends(...)` client over the singleton
 * `PrismaService`.
 */
export const ScopedPrismaProvider: Provider = {
  provide: SCOPED_PRISMA,
  useFactory: (prisma: PrismaService) => createScopedPrisma(prisma),
  inject: [PrismaService],
};
