import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { ScopedBusiness } from './scope/analytics-scope.service';

/**
 * The ONLY way analytics touches raw SQL.
 *
 * The tenancy extension hooks `$allModels` (`scoped-prisma.ts`), and a raw query
 * is not a model operation — so `$queryRaw` bypasses the choke point completely.
 * Reports need raw SQL anyway (`sale_items` has no top-level access, and
 * `groupBy` cannot bucket dates or join), so the scope has to come from
 * somewhere trustworthy: `business.branchIds`, which the scope resolver read
 * through the scoped client.
 *
 * Two guards, both cheap:
 *   1. Never run for a business with no branches — an unbounded query is a bug.
 *   2. Never run SQL whose text lacks `branch_id`. Crude on purpose: it is a
 *      tripwire for a builder that forgot its predicate, and it fires in tests.
 */
function assertScoped(business: ScopedBusiness, sql: Prisma.Sql): void {
  if (business.branchIds.length === 0) {
    throw new Error(
      `runScoped: business ${business.id} has no branches in scope — the caller must skip it.`,
    );
  }
  if (!sql.text.includes('branch_id')) {
    throw new Error(
      'runScoped: analytics SQL must constrain branch_id — refusing to run an unscoped query.',
    );
  }
}

export async function runScoped<T>(
  raw: PrismaService,
  business: ScopedBusiness,
  build: (business: ScopedBusiness) => Prisma.Sql,
): Promise<T[]> {
  const sql = build(business);
  assertScoped(business, sql);
  return raw.$queryRaw<T[]>(sql);
}

/** Single-row variant for aggregates, which always return exactly one row. */
export async function runScopedOne<T>(
  raw: PrismaService,
  business: ScopedBusiness,
  build: (business: ScopedBusiness) => Prisma.Sql,
): Promise<T> {
  const rows = await runScoped<T>(raw, business, build);
  if (rows.length !== 1) {
    throw new Error(
      `runScopedOne: expected exactly one row, got ${rows.length}.`,
    );
  }
  return rows[0];
}
