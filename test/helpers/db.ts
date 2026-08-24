/**
 * Shared test database helpers.
 *
 * resetDb() truncates all application tables and restarts identity sequences.
 * Call it from each suite's beforeEach to guarantee a clean slate.
 *
 * This module is a no-op stub in Task 1 (no Prisma client yet).
 * It is activated in Task 2 when PrismaClient is generated.
 */

/**
 * Truncate all application tables (excludes _prisma_migrations) and
 * restart identity sequences.  Shared factory helpers accrue here as
 * later tasks add them.
 */
export async function resetDb(): Promise<void> {
  // No-op until Task 2 introduces PrismaClient.
  // Task 2 will replace this body with:
  //
  //   const tables = await prisma.$queryRaw<{ tablename: string }[]>`
  //     SELECT tablename FROM pg_tables
  //     WHERE schemaname = 'public'
  //       AND tablename != '_prisma_migrations'
  //   `;
  //   for (const { tablename } of tables) {
  //     await prisma.$executeRawUnsafe(
  //       `TRUNCATE TABLE "${tablename}" RESTART IDENTITY CASCADE`
  //     );
  //   }
}
