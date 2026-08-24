/**
 * Model → scope map for the tenancy/audit choke-point extension (Task 4, §11).
 *
 * This is data, not behavior: it tells the extension which scope column each
 * model is filtered/stamped by. `scoped-prisma.ts` imports it and does ALL the
 * enforcement — this file must stay declarative.
 */

/**
 * Platform-owned tables. In TENANT scope these throw (no BO access). In
 * PLATFORM scope they are read/written by the raw client and auth/system paths,
 * never by business modules through the scoped client.
 */
export const PLATFORM_MODELS = [
  'owner',
  'user',
  'authToken',
  'refreshToken',
] as const;

/**
 * Tenant tables that carry a DIRECT scope column. The value is the column the
 * extension filters reads by and validates/forces on writes:
 *  - "ownerId"    → filtered by ctx.ownerId
 *  - "businessId" → filtered by the owner's allowed businessId set
 *  - "branchId"   → filtered by the owner's allowed branchId set (or pinned to
 *                   ctx.branchId for terminal actors)
 */
export const TENANT_DIRECT: Record<
  string,
  'ownerId' | 'businessId' | 'branchId'
> = {
  business: 'ownerId',
  branch: 'businessId',
  category: 'businessId',
  product: 'businessId',
  modifierGroup: 'businessId',
  discount: 'businessId',
  notification: 'businessId',
  auditLog: 'businessId',
  terminal: 'branchId',
  branchStock: 'branchId',
  stockMovement: 'branchId',
  shift: 'branchId',
  sale: 'branchId',
  stockCount: 'branchId',
  stockBatch: 'branchId',
};

/**
 * Child-only tenant tables: NO top-level access in tenant scope. They are
 * reached through relation queries / nested writes of their scoped parent, so
 * the parent's scope filter transitively protects them. Top-level tenant access
 * throws, naming the parent to query through.
 */
export const CHILD_ONLY_MODELS = [
  'productVariant',
  'modifier',
  'productModifierGroup',
  'saleItem',
  'salePayment',
  'shiftCashMovement',
  'stockCountItem',
] as const;

/**
 * For each child-only model, the parent model to query through — used in the
 * thrown error message so callers know the right entry point.
 */
export const CHILD_PARENT: Record<string, string> = {
  productVariant: 'product',
  modifier: 'modifierGroup',
  productModifierGroup: 'product',
  saleItem: 'sale',
  salePayment: 'sale',
  shiftCashMovement: 'shift',
  stockCountItem: 'stockCount',
};

export const PLATFORM_MODEL_SET: ReadonlySet<string> = new Set(PLATFORM_MODELS);
export const CHILD_ONLY_SET: ReadonlySet<string> = new Set(CHILD_ONLY_MODELS);

/** Models whose direct scope column is `branchId` (need the branch-id set). */
export const BRANCH_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Object.entries(TENANT_DIRECT)
    .filter(([, col]) => col === 'branchId')
    .map(([model]) => model),
);
