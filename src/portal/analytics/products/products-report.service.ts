import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../../prisma/scoped-prisma.provider';
import { NotFoundError } from '../../../common/errors/api-errors';
import { ProductReportQueryDto } from '../dto/product-report-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import {
  AnalyticsScopeService,
  type ScopedBusiness,
} from '../scope/analytics-scope.service';
import { businessDaySeries } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';
import {
  emptyTotals,
  grossProfitC,
  marginPct,
} from '../overview/overview.math';
import type { Granularity } from '../reports/sales-series.sql';
import {
  categorySalesSql,
  productSalesSql,
  productTrendSql,
  zeroSalesSql,
  type CategorySalesRow,
  type ProductSalesRow,
  type ProductTrendRow,
  type ZeroSalesRow,
} from '../reports/product-sales.sql';

const DEFAULT_LIMIT = 20;

export interface SoldRow {
  productId: string;
  variantId: string | null;
  name: string;
  units: number;
  revenueC: number;
  grossProfitC: number | null;
  /** A FRACTION (0.4 = 40%), matching `overview.math`. */
  marginPct: number | null;
}

export interface CategoryRow {
  categoryId: string;
  name: string;
  units: number;
  revenueC: number;
}

export interface TopProductsReport {
  from: string;
  to: string;
  by: 'units' | 'revenue';
  rows: SoldRow[];
  categories: CategoryRow[];
}

export interface SlowProductsReport {
  from: string;
  to: string;
  bottom: SoldRow[];
  zeroSales: { productId: string; name: string; categoryName: string }[];
}

export interface ProductTrendBucket {
  bucket: string;
  units: number;
  revenueC: number;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface ProductTrendReport {
  productId: string;
  from: string;
  to: string;
  granularity: Granularity;
  buckets: ProductTrendBucket[];
}

/** A per-bucket tally before margins are derived. */
interface BucketTally {
  units: number;
  revenueC: number;
  costedLines: number;
  costedRevenueC: number;
  costedCostC: number;
}

/** A merged (product, variant) tally before margins are derived. */
interface Accumulated {
  productId: string;
  variantId: string | null;
  name: string;
  units: number;
  revenueC: number;
  costedLines: number;
  costedRevenueC: number;
  costedCostC: number;
}

/**
 * §3 Products (sold).
 *
 * Rows are keyed by `productId:variantId` across businesses — a product id
 * cannot exist in two businesses, so the key is globally safe and merging is
 * addition.
 *
 * Margins come from `overview.math`, the same functions the overview card uses,
 * so a product whose lines carried no cost reports `null` rather than a zero
 * that would read as 100% margin.
 */
@Injectable()
export class ProductsReportService {
  constructor(
    private readonly raw: PrismaService,
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async top(query: ProductReportQueryDto): Promise<TopProductsReport> {
    const scope = await this.scope.resolve(query);
    const by = query.by ?? 'units';
    const limit = query.limit ?? DEFAULT_LIMIT;

    const sold = await this.sold(scope.businesses);

    const categories = new Map<string, CategoryRow>();
    for (const business of scope.businesses) {
      for (const row of await runScoped<CategorySalesRow>(
        this.raw,
        business,
        categorySalesSql,
      )) {
        const current = categories.get(row.category_id);
        if (current) {
          current.units += row.units;
          current.revenueC += Number(row.revenue_c);
        } else {
          categories.set(row.category_id, {
            categoryId: row.category_id,
            name: row.name,
            units: row.units,
            revenueC: Number(row.revenue_c),
          });
        }
      }
    }

    await this.reportAudit.log(scope, 'products-top', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      by,
      rows: rank(sold, by, 'desc').slice(0, limit),
      categories: [...categories.values()].sort(
        (a, b) => b.revenueC - a.revenueC,
      ),
    };
  }

  async slow(query: ProductReportQueryDto): Promise<SlowProductsReport> {
    const scope = await this.scope.resolve(query);
    const by = query.by ?? 'units';
    const limit = query.limit ?? DEFAULT_LIMIT;

    const sold = await this.sold(scope.businesses);

    const zeroSales: SlowProductsReport['zeroSales'] = [];
    for (const business of scope.businesses) {
      for (const row of await runScoped<ZeroSalesRow>(
        this.raw,
        business,
        zeroSalesSql,
      )) {
        zeroSales.push({
          productId: row.product_id,
          name: row.name,
          categoryName: row.category_name,
        });
      }
    }

    await this.reportAudit.log(scope, 'products-slow', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      bottom: rank(sold, by, 'asc').slice(0, limit),
      zeroSales,
    };
  }

  /**
   * Ownership is enforced by the SCOPED client rather than by matching business
   * ids: the choke point already filters products to the caller's businesses, so
   * a product that comes back null is either missing or somebody else's — and
   * both answer 404 without leaking which.
   */
  async trend(
    productId: string,
    query: SalesTrendQueryDto,
  ): Promise<ProductTrendReport> {
    const owned = await this.scoped.product.findFirst({
      where: { id: productId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundError('Product not found.');

    const scope = await this.scope.resolve(query);
    const granularity = query.granularity ?? 'day';
    const merged = new Map<string, BucketTally>();

    for (const business of scope.businesses) {
      for (const row of await runScoped<ProductTrendRow>(
        this.raw,
        business,
        (b) => productTrendSql(b, productId, granularity),
      )) {
        const key = row.bucket.toISOString().slice(0, 10);
        const current = merged.get(key);
        if (current) {
          current.units += row.units;
          current.revenueC += Number(row.revenue_c);
          current.costedLines += Number(row.costed_lines);
          current.costedRevenueC += Number(row.costed_revenue_c);
          current.costedCostC += Number(row.costed_cost_c);
        } else {
          merged.set(key, {
            units: row.units,
            revenueC: Number(row.revenue_c),
            costedLines: Number(row.costed_lines),
            costedRevenueC: Number(row.costed_revenue_c),
            costedCostC: Number(row.costed_cost_c),
          });
        }
      }
    }

    // Day granularity zero-fills from the requested range so a gap reads as a
    // gap. Coarser buckets come from the data, where a partial week at either
    // edge would otherwise be indistinguishable from a quiet one.
    const keys =
      granularity === 'day'
        ? businessDaySeries(scope.from, scope.to)
        : [...merged.keys()].sort();

    await this.reportAudit.log(scope, 'product-trend', query.format ?? 'json');

    return {
      productId,
      from: scope.from,
      to: scope.to,
      granularity,
      buckets: keys.map((bucket) => {
        const row = merged.get(bucket);
        const totals = {
          ...emptyTotals(),
          costedLines: row?.costedLines ?? 0,
          costedRevenueC: row?.costedRevenueC ?? 0,
          costedCostC: row?.costedCostC ?? 0,
        };
        return {
          bucket,
          units: row?.units ?? 0,
          revenueC: row?.revenueC ?? 0,
          grossProfitC: grossProfitC(totals),
          marginPct: marginPct(totals),
        };
      }),
    };
  }

  private async sold(businesses: ScopedBusiness[]): Promise<Accumulated[]> {
    const merged = new Map<string, Accumulated>();

    for (const business of businesses) {
      for (const row of await runScoped<ProductSalesRow>(
        this.raw,
        business,
        productSalesSql,
      )) {
        const key = `${row.product_id}:${row.variant_id ?? ''}`;
        const current = merged.get(key);
        if (current) {
          current.units += row.units;
          current.revenueC += Number(row.revenue_c);
          current.costedLines += Number(row.costed_lines);
          current.costedRevenueC += Number(row.costed_revenue_c);
          current.costedCostC += Number(row.costed_cost_c);
        } else {
          merged.set(key, {
            productId: row.product_id,
            variantId: row.variant_id,
            name: row.name,
            units: row.units,
            revenueC: Number(row.revenue_c),
            costedLines: Number(row.costed_lines),
            costedRevenueC: Number(row.costed_revenue_c),
            costedCostC: Number(row.costed_cost_c),
          });
        }
      }
    }

    return [...merged.values()];
  }
}

function toSoldRow(row: Accumulated): SoldRow {
  const totals = {
    ...emptyTotals(),
    costedLines: row.costedLines,
    costedRevenueC: row.costedRevenueC,
    costedCostC: row.costedCostC,
  };
  return {
    productId: row.productId,
    variantId: row.variantId,
    name: row.name,
    units: row.units,
    revenueC: row.revenueC,
    grossProfitC: grossProfitC(totals),
    marginPct: marginPct(totals),
  };
}

function rank(
  rows: Accumulated[],
  by: 'units' | 'revenue',
  direction: 'asc' | 'desc',
): SoldRow[] {
  const sorted = [...rows].sort((a, b) => {
    const left = by === 'units' ? a.units : a.revenueC;
    const right = by === 'units' ? b.units : b.revenueC;
    return direction === 'desc' ? right - left : left - right;
  });
  return sorted.map(toSoldRow);
}
