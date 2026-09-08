import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import {
  discountTotalsSql,
  lineDiscountsSql,
  miscLinesSql,
  orderDiscountsSql,
  overShortSql,
  statusValueSql,
  type DiscountTotalsRow,
  type MiscLinesRow,
  type NamedDiscountRow,
  type OverShortRow,
  type StatusValueRow,
} from '../reports/leaks.sql';

export interface NamedDiscount {
  discountId: string;
  name: string;
  kind: string;
  timesUsed: number;
  amountC: number;
}

export interface StatusBucket {
  count: number;
  valueC: number;
  reasons: { reason: string; count: number; valueC: number }[];
}

export interface OverShortEntry {
  shiftId: string;
  branchId: string;
  branchName: string;
  closedAt: Date;
  expectedCashC: number | null;
  closingCashC: number | null;
  /** `closing − expected`, so negative is short. Null if either is unrecorded. */
  varianceC: number | null;
}

export interface LeaksReport {
  from: string;
  to: string;
  discountsByName: NamedDiscount[];
  /** The remainder `sales.discount` carries that no line accounts for. */
  orderLevelDiscountC: number;
  scPwd: { discountC: number; vatExemptSalesC: number; saleCount: number };
  /** `pctOfNetSales` is a FRACTION, and null when there were no net sales. */
  miscLines: { revenueC: number; pctOfNetSales: number | null };
  voids: StatusBucket;
  refunds: StatusBucket;
  overShort: OverShortEntry[];
}

/**
 * §4 Leaks — where money goes that is not cost.
 *
 * `pctOfNetSales` is `null` rather than `0` when nothing sold: a ratio with
 * nothing underneath it is undefined, not zero. Same reasoning as the null-cost
 * rule, and the portal renders an em dash either way.
 */
@Injectable()
export class LeaksReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<LeaksReport> {
    const scope = await this.scope.resolve(query);

    const named = new Map<string, NamedDiscount>();
    const voidReasons = new Map<string, { count: number; valueC: number }>();
    const refundReasons = new Map<string, { count: number; valueC: number }>();
    const overShort: OverShortEntry[] = [];

    let orderLevelDiscountC = 0;
    let scPwdDiscountC = 0;
    let vatExemptSalesC = 0;
    let scPwdSales = 0;
    let miscRevenueC = 0;
    let netSalesC = 0;

    for (const business of scope.businesses) {
      const totals = await runScopedOne<DiscountTotalsRow>(
        this.raw,
        business,
        discountTotalsSql,
      );
      // Σ line promos = Σ line discounts − Σ SC/PWD, because a line carries one
      // or the other and `sale_items.discount` does not say which.
      const linePromos =
        Number(totals.line_discount_c) - Number(totals.sc_pwd_discount_c);
      orderLevelDiscountC += Number(totals.sale_discount_c) - linePromos;
      scPwdDiscountC += Number(totals.sc_pwd_discount_c);
      vatExemptSalesC += Number(totals.vat_exempt_sales_c);
      scPwdSales += Number(totals.sc_pwd_sales);
      netSalesC += Number(totals.net_sales_c);

      const misc = await runScopedOne<MiscLinesRow>(
        this.raw,
        business,
        miscLinesSql,
      );
      miscRevenueC += Number(misc.revenue_c);

      for (const sql of [lineDiscountsSql, orderDiscountsSql]) {
        for (const row of await runScoped<NamedDiscountRow>(
          this.raw,
          business,
          sql,
        )) {
          const current = named.get(row.discount_id);
          if (current) {
            current.timesUsed += Number(row.times_used);
            current.amountC += Number(row.amount_c);
          } else {
            named.set(row.discount_id, {
              discountId: row.discount_id,
              name: row.name,
              kind: row.kind,
              timesUsed: Number(row.times_used),
              amountC: Number(row.amount_c),
            });
          }
        }
      }

      for (const row of await runScoped<StatusValueRow>(
        this.raw,
        business,
        statusValueSql,
      )) {
        const target = row.status === 'voided' ? voidReasons : refundReasons;
        const current = target.get(row.reason) ?? { count: 0, valueC: 0 };
        target.set(row.reason, {
          count: current.count + Number(row.count),
          valueC: current.valueC + Number(row.value_c),
        });
      }

      for (const row of await runScoped<OverShortRow>(
        this.raw,
        business,
        overShortSql,
      )) {
        overShort.push({
          shiftId: row.shift_id,
          branchId: row.branch_id,
          branchName: row.branch_name,
          closedAt: row.closed_at,
          expectedCashC: row.expected_cash,
          closingCashC: row.closing_cash,
          // Unknown, not zero, if the close never recorded both figures.
          varianceC:
            row.expected_cash === null || row.closing_cash === null
              ? null
              : row.closing_cash - row.expected_cash,
        });
      }
    }

    await this.reportAudit.log(scope, 'leaks', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      discountsByName: [...named.values()].sort(
        (a, b) => b.amountC - a.amountC,
      ),
      orderLevelDiscountC,
      scPwd: {
        discountC: scPwdDiscountC,
        vatExemptSalesC,
        saleCount: scPwdSales,
      },
      miscLines: {
        revenueC: miscRevenueC,
        pctOfNetSales: netSalesC === 0 ? null : miscRevenueC / netSalesC,
      },
      voids: toBucket(voidReasons),
      refunds: toBucket(refundReasons),
      overShort: overShort.sort(
        (a, b) => b.closedAt.getTime() - a.closedAt.getTime(),
      ),
    };
  }
}

function toBucket(
  reasons: Map<string, { count: number; valueC: number }>,
): StatusBucket {
  const rows = [...reasons.entries()]
    .map(([reason, r]) => ({ reason, ...r }))
    .sort((a, b) => b.valueC - a.valueC);
  return {
    count: rows.reduce((sum, r) => sum + r.count, 0),
    valueC: rows.reduce((sum, r) => sum + r.valueC, 0),
    reasons: rows,
  };
}
