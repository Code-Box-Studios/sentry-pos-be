import type { ScopedPrisma } from '../../prisma/scoped-prisma.provider';
import { NotFoundError } from '../../common/errors/api-errors';

/**
 * Assert a business exists AND belongs to the caller. The scoped read is
 * auto-filtered to the owner's businesses, so a foreign or missing/soft-deleted
 * business returns null → 404 (no cross-tenant existence leak). Shared by the
 * tenant-scope portal services.
 */
export async function assertBusinessOwned(
  scoped: ScopedPrisma,
  businessId: string,
): Promise<void> {
  const biz = await scoped.business.findFirst({
    where: { id: businessId },
    select: { id: true },
  });
  if (!biz) throw new NotFoundError('Business not found.');
}
