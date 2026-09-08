import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { businessDaySeries } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import {
  emptyTotals,
  grossProfitC,
  marginPct,
} from '../overview/overview.math';
import {
  lineAggregateSql,
  type LineAggregateRow,
} from '../reports/sales-aggregate.sql';
import {
  trendLinesSql,
  type Granularity,
  type TrendProfitRow,
} from '../reports/sales-series.sql';
import {
  categorySalesSql,
  productSalesSql,
  type CategorySalesRow,
  type ProductSalesRow,
} from '../reports/product-sales.sql';

export interface MarginFigures {
  revenueC: number;
  /** UNKNOWN, not zero, when no line in the group carried a cost. */
  costC: number | null;
  grossProfitC: number | null;
  /** A FRACTION (0.4 = 40%), matching `overview.math`. */
  marginPct: number | null;
}

export interface ProductMarginRow extends MarginFigures {
  productId: string;
  variantId: string | null;
  name: string;
}

export interface CategoryMarginRow extends MarginFigures {
  categoryId: string;
  name: string;
}

export interface ProfitBucket {
  bucket: string;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface ProfitReport {
  from: string;
  to: string;
  granularity: Granularity;
  overTime: ProfitBucket[];
  byProduct: ProductMarginRow[];
  byCategory: CategoryMarginRow[];
  costedRevenueC: number;
  uncostedRevenueC: number;
}

/** A running tally before margins are derived. */
interface Costed {
  revenueC: number;
  costedLines: number;
  costedRevenueC: number;
  costedCostC: number;
}

function emptyCosted(): Costed {
  return { revenueC: 0, costedLines: 0, costedRevenueC: 0, costedCostC: 0 };
}

function addInto(target: Costed, add: Costed): void {
  target.revenueC += add.revenueC;
  target.costedLines += add.costedLines;
  target.costedRevenueC += add.costedRevenueC;
  target.costedCostC += add.costedCostC;
}

function marginsOf(c: Costed): MarginFigures {
  const totals = {
    ...emptyTotals(),
    costedLines: c.costedLines,
    costedRevenueC: c.costedRevenueC,
    costedCostC: c.costedCostC,
  };
  return {
    revenueC: c.revenueC,
    costC: c.costedLines === 0 ? null : c.costedCostC,
    grossProfitC: grossProfitC(totals),
    marginPct: marginPct(totals),
  };
}

/**
 * §4 Profit.
 *
 * Every margin comes from `overview.math`, so a product's margin, a category's
 * margin and the overview card's margin are computed by one function. A cost
 * that was never recorded reports `null` at every level — the report says
 * "unknown", and the portal renders an em dash.
 */
@Injectable()
export class ProfitReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: SalesTrendQueryDto): Promise<ProfitReport> {
    const scope = await this.scope.resolve(query);
    const granularity = query.granularity ?? 'day';

    const overTime = new Map<string, Costed>();
    const byProduct = new Map<
      string,
      Costed & Omit<ProductMarginRow, keyof MarginFigures>
    >();
    const byCategory = new Map<
      string,
      Costed & Omit<CategoryMarginRow, keyof MarginFigures>
    >();
    let costedRevenueC = 0;
    let uncostedRevenueC = 0;

    for (const business of scope.businesses) {
      for (const row of await runScoped<TrendProfitRow>(
        this.raw,
        business,
        (b) => trendLinesSql(b, granularity),
      )) {
        const key = row.bucket.toISOString().slice(0, 10);
        const current = overTime.get(key) ?? emptyCosted();
        addInto(current, {
          revenueC: 0,
          costedLines: Number(row.costed_lines),
          costedRevenueC: Number(row.costed_revenue_c),
          costedCostC: Number(row.costed_cost_c),
        });
        overTime.set(key, current);
      }

      for (const row of await runScoped<ProductSalesRow>(
        this.raw,
        business,
        productSalesSql,
      )) {
        const key = `${row.product_id}:${row.variant_id ?? ''}`;
        const current = byProduct.get(key) ?? {
          ...emptyCosted(),
          productId: row.product_id,
          variantId: row.variant_id,
          name: row.name,
        };
        addInto(current, {
          revenueC: Number(row.revenue_c),
          costedLines: Number(row.costed_lines),
          costedRevenueC: Number(row.costed_revenue_c),
          costedCostC: Number(row.costed_cost_c),
        });
        byProduct.set(key, current);
      }

      for (const row of await runScoped<CategorySalesRow>(
        this.raw,
        business,
        categorySalesSql,
      )) {
        const current = byCategory.get(row.category_id) ?? {
          ...emptyCosted(),
          categoryId: row.category_id,
          name: row.name,
        };
        addInto(current, {
          revenueC: Number(row.revenue_c),
          costedLines: Number(row.costed_lines),
          costedRevenueC: Number(row.costed_revenue_c),
          costedCostC: Number(row.costed_cost_c),
        });
        byCategory.set(row.category_id, current);
      }

      const totals = await runScopedOne<LineAggregateRow>(
        this.raw,
        business,
        (b) => lineAggregateSql(b, b.fromUtc, b.toUtc),
      );
      costedRevenueC += Number(totals.costed_revenue_c);
      uncostedRevenueC += Number(totals.uncosted_revenue_c);
    }

    // Day granularity zero-fills from the requested range so a gap reads as a
    // gap; coarser buckets come from the data, where a partial week at either
    // edge would otherwise be indistinguishable from a quiet one.
    const keys =
      granularity === 'day'
        ? businessDaySeries(scope.from, scope.to)
        : [...overTime.keys()].sort();

    await this.reportAudit.log(scope, 'profit', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      granularity,
      overTime: keys.map((bucket) => {
        const margins = marginsOf(overTime.get(bucket) ?? emptyCosted());
        return {
          bucket,
          grossProfitC: margins.grossProfitC,
          marginPct: margins.marginPct,
        };
      }),
      byProduct: [...byProduct.values()]
        .map((row) => ({
          productId: row.productId,
          variantId: row.variantId,
          name: row.name,
          ...marginsOf(row),
        }))
        .sort((a, b) => b.revenueC - a.revenueC),
      byCategory: [...byCategory.values()]
        .map((row) => ({
          categoryId: row.categoryId,
          name: row.name,
          ...marginsOf(row),
        }))
        .sort((a, b) => b.revenueC - a.revenueC),
      costedRevenueC,
      uncostedRevenueC,
    };
  }
}
