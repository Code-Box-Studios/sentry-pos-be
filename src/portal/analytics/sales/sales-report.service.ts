import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { businessDaySeries } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';
import {
  branchBreakdownSql,
  dowPatternSql,
  heatmapSql,
  hourPatternSql,
  orderTypeBreakdownSql,
  paymentBreakdownSql,
  trendLinesSql,
  trendSalesSql,
  type BranchSalesRow,
  type BucketRow,
  type DowRow,
  type Granularity,
  type HourRow,
  type MethodRow,
  type OrderTypeRow,
  type TrendProfitRow,
} from '../reports/sales-series.sql';

export interface HeatmapDay {
  date: string;
  salesC: number;
  transactions: number;
}

export interface TrendBucket {
  bucket: string;
  salesC: number;
  grossProfitC: number | null;
  transactions: number;
}

export interface PatternsReport {
  hourOfDay: { hour: number; salesC: number; transactions: number }[];
  dayOfWeek: { dayOfWeek: number; salesC: number; transactions: number }[];
}

export interface BreakdownsReport {
  byPaymentMethod: { method: string; salesC: number; transactions: number }[];
  byOrderType: { orderType: string; salesC: number; transactions: number }[];
  byBranch: {
    branchId: string;
    name: string;
    salesC: number;
    transactions: number;
  }[];
}

/** A Postgres `date` arrives as a Date at UTC midnight; take its date part. */
function bucketKey(bucket: Date): string {
  return bucket.toISOString().slice(0, 10);
}

/**
 * Bucketed sales reports (analytics-spec §2).
 *
 * Buckets are summed ACROSS businesses by their date key, which is only sound
 * because each business's bucket was computed against its own `dayStartTime`
 * before it got here — the SQL never spans businesses.
 */
@Injectable()
export class SalesReportService {
  constructor(
    private readonly scope: AnalyticsScopeService,
    private readonly raw: PrismaService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async heatmap(query: AnalyticsQueryDto): Promise<HeatmapDay[]> {
    const scope = await this.scope.resolve(query);
    const sales = new Map<string, { salesC: number; transactions: number }>();

    for (const business of scope.businesses) {
      const rows = await runScoped<BucketRow>(this.raw, business, heatmapSql);
      for (const row of rows) {
        const key = bucketKey(row.bucket);
        const acc = sales.get(key) ?? { salesC: 0, transactions: 0 };
        acc.salesC += Number(row.sales_c);
        acc.transactions += Number(row.transactions);
        sales.set(key, acc);
      }
    }

    await this.reportAudit.log(scope, 'sales-heatmap', query.format ?? 'json');

    // Zero-fill so the calendar grid has no holes.
    return businessDaySeries(scope.from, scope.to).map((date) => ({
      date,
      salesC: sales.get(date)?.salesC ?? 0,
      transactions: sales.get(date)?.transactions ?? 0,
    }));
  }

  async trend(query: SalesTrendQueryDto): Promise<TrendBucket[]> {
    const scope = await this.scope.resolve(query);
    const granularity: Granularity = query.granularity ?? 'day';

    const sales = new Map<string, { salesC: number; transactions: number }>();
    const profit = new Map<
      string,
      { costedLines: number; revenueC: number; costC: number }
    >();

    for (const business of scope.businesses) {
      const [salesRows, lineRows] = await Promise.all([
        runScoped<BucketRow>(this.raw, business, (b) =>
          trendSalesSql(b, granularity),
        ),
        runScoped<TrendProfitRow>(this.raw, business, (b) =>
          trendLinesSql(b, granularity),
        ),
      ]);

      for (const row of salesRows) {
        const key = bucketKey(row.bucket);
        const acc = sales.get(key) ?? { salesC: 0, transactions: 0 };
        acc.salesC += Number(row.sales_c);
        acc.transactions += Number(row.transactions);
        sales.set(key, acc);
      }
      for (const row of lineRows) {
        const key = bucketKey(row.bucket);
        const acc = profit.get(key) ?? {
          costedLines: 0,
          revenueC: 0,
          costC: 0,
        };
        acc.costedLines += Number(row.costed_lines);
        acc.revenueC += Number(row.costed_revenue_c);
        acc.costC += Number(row.costed_cost_c);
        profit.set(key, acc);
      }
    }

    await this.reportAudit.log(scope, 'sales-trend', query.format ?? 'json');

    // Only buckets that saw sales are returned: a month or week grid is the
    // portal's business, and zero-filling months would need its own calendar.
    return [...sales.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, row]) => {
        const p = profit.get(bucket);
        return {
          bucket,
          salesC: row.salesC,
          grossProfitC: p && p.costedLines > 0 ? p.revenueC - p.costC : null,
          transactions: row.transactions,
        };
      });
  }

  async patterns(query: AnalyticsQueryDto): Promise<PatternsReport> {
    const scope = await this.scope.resolve(query);
    const hours = Array.from({ length: 24 }, () => ({
      salesC: 0,
      transactions: 0,
    }));
    const days = Array.from({ length: 7 }, () => ({
      salesC: 0,
      transactions: 0,
    }));

    for (const business of scope.businesses) {
      const [hourRows, dowRows] = await Promise.all([
        runScoped<HourRow>(this.raw, business, hourPatternSql),
        runScoped<DowRow>(this.raw, business, dowPatternSql),
      ]);
      for (const row of hourRows) {
        hours[row.hour].salesC += Number(row.sales_c);
        hours[row.hour].transactions += Number(row.transactions);
      }
      for (const row of dowRows) {
        days[row.day_of_week].salesC += Number(row.sales_c);
        days[row.day_of_week].transactions += Number(row.transactions);
      }
    }

    await this.reportAudit.log(scope, 'sales-patterns', query.format ?? 'json');

    return {
      hourOfDay: hours.map((h, hour) => ({ hour, ...h })),
      dayOfWeek: days.map((d, dayOfWeek) => ({ dayOfWeek, ...d })),
    };
  }

  async breakdowns(query: AnalyticsQueryDto): Promise<BreakdownsReport> {
    const scope = await this.scope.resolve(query);
    const methods = new Map<string, { salesC: number; transactions: number }>();
    const orderTypes = new Map<
      string,
      { salesC: number; transactions: number }
    >();
    const branches: BreakdownsReport['byBranch'] = [];

    for (const business of scope.businesses) {
      const [methodRows, typeRows, branchRows] = await Promise.all([
        runScoped<MethodRow>(this.raw, business, paymentBreakdownSql),
        runScoped<OrderTypeRow>(this.raw, business, orderTypeBreakdownSql),
        runScoped<BranchSalesRow>(this.raw, business, branchBreakdownSql),
      ]);

      for (const row of methodRows) {
        const acc = methods.get(row.method) ?? { salesC: 0, transactions: 0 };
        acc.salesC += Number(row.sales_c);
        acc.transactions += Number(row.transactions);
        methods.set(row.method, acc);
      }
      for (const row of typeRows) {
        const acc = orderTypes.get(row.order_type) ?? {
          salesC: 0,
          transactions: 0,
        };
        acc.salesC += Number(row.sales_c);
        acc.transactions += Number(row.transactions);
        orderTypes.set(row.order_type, acc);
      }
      for (const row of branchRows) {
        branches.push({
          branchId: row.branch_id,
          name: row.name,
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }
    }

    await this.reportAudit.log(
      scope,
      'sales-breakdowns',
      query.format ?? 'json',
    );

    return {
      byPaymentMethod: [...methods.entries()].map(([method, v]) => ({
        method,
        ...v,
      })),
      byOrderType: [...orderTypes.entries()].map(([orderType, v]) => ({
        orderType,
        ...v,
      })),
      byBranch: branches.sort((a, b) => b.salesC - a.salesC),
    };
  }
}
