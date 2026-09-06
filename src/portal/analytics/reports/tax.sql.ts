import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * Tax summary (analytics-spec §6).
 *
 * The columns mirror the engine's `CartTotals` exactly — `vatableSalesC` is
 * `total - vatExemptSales - vat` there (`totals.ts`), so it is the same
 * subtraction here. Computing it any other way would let a receipt and this
 * report disagree, which is the one thing an accountant's view cannot do.
 */
export interface TaxRow {
  vatable_sales_c: bigint;
  vat_c: bigint;
  vat_exempt_sales_c: bigint;
  sc_pwd_discount_c: bigint;
  service_charge_c: bigint;
}

export function taxSummarySql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(s.total - s.vat_exempt_sales - s.tax), 0)::bigint AS vatable_sales_c,
      COALESCE(SUM(s.tax), 0)::bigint                                AS vat_c,
      COALESCE(SUM(s.vat_exempt_sales), 0)::bigint                   AS vat_exempt_sales_c,
      COALESCE(SUM(s.sc_pwd_discount), 0)::bigint                    AS sc_pwd_discount_c,
      COALESCE(SUM(s.service_charge), 0)::bigint                     AS service_charge_c
    FROM sales s
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND s.status = 'completed'
      AND s.created_at >= ${business.fromUtc}
      AND s.created_at <  ${business.toUtc}
  `;
}
