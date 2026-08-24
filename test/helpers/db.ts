import { PrismaClient } from '@prisma/client';

/**
 * Shared test database helpers.
 *
 * resetDb() truncates all application tables and restarts identity sequences.
 * Call it from each suite's beforeEach to guarantee a clean slate.
 */

const prisma = new PrismaClient();

/**
 * Truncate all application tables (excludes _prisma_migrations) and
 * restart identity sequences.
 */
export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename != '_prisma_migrations'
  `;

  for (const { tablename } of tables) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "${tablename}" RESTART IDENTITY CASCADE`,
    );
  }
}

export { prisma };
