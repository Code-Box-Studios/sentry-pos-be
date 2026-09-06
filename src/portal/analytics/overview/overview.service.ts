import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScopedOne } from '../scoped-sql';
import {
  lineAggregateSql,
  salesAggregateSql,
  type LineAggregateRow,
  type SalesAggregateRow,
} from '../reports/sales-aggregate.sql';
import {
  addRows,
  averageBasketC,
  emptyTotals,
  grossProfitC,
  marginPct,
  netSalesC,
  toKpi,
  toMarginKpi,
  toNullableKpi,
  type Kpi,
  type MarginKpi,
  type NullableKpi,
  type Totals,
} from './overview.math';

export interface OverviewReport {
  from: string;
  to: string;
  grossSalesC: Kpi;
  discountsC: Kpi;
  netSalesC: Kpi;
  serviceChargeC: Kpi;
  transactions: Kpi;
  voidCount: Kpi;
  refundCount: Kpi;
  averageBasketC: NullableKpi;
  grossProfitC: NullableKpi;
  marginPct: MarginKpi;
  /** How much of this period's revenue the profit figure actually covers. */
  costedRevenueC: number;
  uncostedRevenueC: number;
}

/**
 * Overview KPIs (analytics-spec §1) with a comparison against the equal period
 * immediately before.
 *
 * Queries run PER BUSINESS because each has its own `dayStartTime` and therefore
 * its own UTC window; the rows are summed here. A business with no branches in
 * scope never reaches the loop — `runScoped` refuses an unbounded query — and
 * its absence simply leaves the totals at zero.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly scope: AnalyticsScopeService,
    private readonly raw: PrismaService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<OverviewReport> {
    const scope = await this.scope.resolve(query);
    const current = emptyTotals();
    const previous = emptyTotals();

    for (const business of scope.businesses) {
      const [salesNow, salesThen, linesNow, linesThen] = await Promise.all([
        runScopedOne<SalesAggregateRow>(this.raw, business, (b) =>
          salesAggregateSql(b, b.fromUtc, b.toUtc),
        ),
        runScopedOne<SalesAggregateRow>(this.raw, business, (b) =>
          salesAggregateSql(b, b.previousFromUtc, b.previousToUtc),
        ),
        runScopedOne<LineAggregateRow>(this.raw, business, (b) =>
          lineAggregateSql(b, b.fromUtc, b.toUtc),
        ),
        runScopedOne<LineAggregateRow>(this.raw, business, (b) =>
          lineAggregateSql(b, b.previousFromUtc, b.previousToUtc),
        ),
      ]);
      addRows(current, salesNow, linesNow);
      addRows(previous, salesThen, linesThen);
    }

    await this.reportAudit.log(scope, 'overview', query.format ?? 'json');
    return build(scope.from, scope.to, current, previous);
  }
}

function build(
  from: string,
  to: string,
  current: Totals,
  previous: Totals,
): OverviewReport {
  return {
    from,
    to,
    grossSalesC: toKpi(current.grossSalesC, previous.grossSalesC),
    discountsC: toKpi(current.discountsC, previous.discountsC),
    netSalesC: toKpi(netSalesC(current), netSalesC(previous)),
    serviceChargeC: toKpi(current.serviceChargeC, previous.serviceChargeC),
    transactions: toKpi(current.transactions, previous.transactions),
    voidCount: toKpi(current.voidCount, previous.voidCount),
    refundCount: toKpi(current.refundCount, previous.refundCount),
    averageBasketC: toNullableKpi(
      averageBasketC(current),
      averageBasketC(previous),
    ),
    grossProfitC: toNullableKpi(grossProfitC(current), grossProfitC(previous)),
    marginPct: toMarginKpi(marginPct(current), marginPct(previous)),
    costedRevenueC: current.costedRevenueC,
    uncostedRevenueC: current.uncostedRevenueC,
  };
}
