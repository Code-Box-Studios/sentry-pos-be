import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../../prisma/scoped-prisma.provider';
import {
  AnalyticsScopeService,
  type ScopedBusiness,
} from '../scope/analytics-scope.service';
import {
  addDays,
  businessDayOf,
  businessDayStartUtc,
} from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import {
  dashboardBranchSql,
  dashboardSparklineSql,
  lowStockCountSql,
  type CountRow,
  type DashboardBranchRow,
  type SparklineRow,
} from '../reports/dashboard.sql';

const SPARKLINE_DAYS = 7;
const UNCLOSED_SHIFT_HOURS = 24;

export interface DayFigures {
  salesC: number;
  grossProfitC: number | null;
  transactions: number;
}

export interface DashboardReport {
  businesses: {
    businessId: string;
    name: string;
    today: DayFigures;
    sameDayLastWeek: DayFigures;
    branches: (DayFigures & { branchId: string; name: string })[];
    sparkline: { date: string; salesC: number }[];
  }[];
  live: {
    openShifts: {
      shiftId: string;
      businessId: string;
      branchId: string;
      branchName: string;
      terminalName: string;
      openedAt: Date;
    }[];
    terminals: {
      terminalId: string;
      businessId: string;
      branchId: string;
      name: string;
      code: string;
      lastSeenAt: Date | null;
      paired: boolean;
    }[];
    unreadNotifications: number;
  };
  attention: {
    lowStock: { businessId: string; count: number }[];
    unclosedShifts: { businessId: string; count: number }[];
  };
}

function figuresOf(rows: DashboardBranchRow[]): DayFigures {
  const costedLines = rows.reduce((n, r) => n + Number(r.costed_lines), 0);
  const revenue = rows.reduce((n, r) => n + Number(r.costed_revenue_c), 0);
  const cost = rows.reduce((n, r) => n + Number(r.costed_cost_c), 0);
  return {
    salesC: rows.reduce((n, r) => n + Number(r.sales_c), 0),
    // Null, never zero: an uncosted day has an unknown profit.
    grossProfitC: costedLines === 0 ? null : revenue - cost,
    transactions: rows.reduce((n, r) => n + Number(r.transactions), 0),
  };
}

function branchIndex(businesses: ScopedBusiness[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const business of businesses) {
    for (const branchId of business.branchIds) index.set(branchId, business.id);
  }
  return index;
}

/**
 * The portal landing (analytics-spec §0): "is everything okay?" in zero clicks.
 *
 * Spans every non-demo business and ignores the business switcher by design, so
 * it takes no scope parameters. Each business is windowed on its OWN today —
 * see `resolveToday`.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly scope: AnalyticsScopeService,
    private readonly raw: PrismaService,
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(now: Date): Promise<DashboardReport> {
    const scope = await this.scope.resolveToday(now);
    const businesses: DashboardReport['businesses'] = [];
    const lowStock: DashboardReport['attention']['lowStock'] = [];

    for (const business of scope.businesses) {
      const [todayRows, lastWeekRows, sparkRows, low] = await Promise.all([
        runScoped<DashboardBranchRow>(this.raw, business, (b) =>
          dashboardBranchSql(b, b.fromUtc, b.toUtc),
        ),
        runScoped<DashboardBranchRow>(this.raw, business, (b) =>
          dashboardBranchSql(b, b.previousFromUtc, b.previousToUtc),
        ),
        this.sparkline(business, now),
        runScopedOne<CountRow>(this.raw, business, lowStockCountSql),
      ]);

      businesses.push({
        businessId: business.id,
        name: business.name,
        today: figuresOf(todayRows),
        sameDayLastWeek: figuresOf(lastWeekRows),
        branches: todayRows.map((row) => ({
          branchId: row.branch_id,
          name: row.name,
          ...figuresOf([row]),
        })),
        sparkline: sparkRows,
      });

      lowStock.push({ businessId: business.id, count: Number(low.count) });
    }

    const [openShifts, terminals, unreadNotifications, unclosedShifts] =
      await Promise.all([
        this.openShifts(scope.businesses),
        this.terminals(scope.businesses),
        this.scoped.notification.count({ where: { readAt: null } }),
        this.unclosedShifts(scope.businesses, now),
      ]);

    await this.reportAudit.log(scope, 'dashboard', 'json');

    return {
      businesses,
      live: { openShifts, terminals, unreadNotifications },
      attention: { lowStock, unclosedShifts },
    };
  }

  /** Seven business days ending today, zero-filled so the chart has no gaps. */
  private async sparkline(
    business: ScopedBusiness,
    now: Date,
  ): Promise<{ date: string; salesC: number }[]> {
    const today = businessDayOf(now, business.dayStartMinutes);
    const first = addDays(today, -(SPARKLINE_DAYS - 1));
    const fromUtc = businessDayStartUtc(first, business.dayStartMinutes);

    const rows = await runScoped<SparklineRow>(this.raw, business, (b) =>
      dashboardSparklineSql(b, fromUtc, b.toUtc),
    );
    const byDate = new Map(
      rows.map((r) => [r.bucket.toISOString().slice(0, 10), Number(r.sales_c)]),
    );

    return Array.from({ length: SPARKLINE_DAYS }, (_, i) => {
      const date = addDays(first, i);
      return { date, salesC: byDate.get(date) ?? 0 };
    });
  }

  private async openShifts(businesses: ScopedBusiness[]) {
    const branchToBusiness = branchIndex(businesses);
    const rows = await this.scoped.shift.findMany({
      where: { branchId: { in: [...branchToBusiness.keys()] }, closedAt: null },
      select: {
        id: true,
        branchId: true,
        openedAt: true,
        branch: { select: { name: true } },
        terminal: { select: { name: true } },
      },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map((row) => ({
      shiftId: row.id,
      businessId: branchToBusiness.get(row.branchId) ?? '',
      branchId: row.branchId,
      branchName: row.branch.name,
      terminalName: row.terminal.name,
      openedAt: row.openedAt,
    }));
  }

  private async terminals(businesses: ScopedBusiness[]) {
    const branchToBusiness = branchIndex(businesses);
    const rows = await this.scoped.terminal.findMany({
      where: { branchId: { in: [...branchToBusiness.keys()] } },
      select: {
        id: true,
        branchId: true,
        name: true,
        code: true,
        lastSeenAt: true,
        deviceTokenHash: true,
      },
      orderBy: { code: 'asc' },
    });
    return rows.map((row) => ({
      terminalId: row.id,
      businessId: branchToBusiness.get(row.branchId) ?? '',
      branchId: row.branchId,
      name: row.name,
      code: row.code,
      lastSeenAt: row.lastSeenAt,
      // The token hash never leaves the service — only whether one exists.
      paired: row.deviceTokenHash !== null,
    }));
  }

  /**
   * A shift open longer than 24 hours is an operator error worth surfacing: a
   * drawer belongs to one day of trading, so anything longer means someone went
   * home without closing.
   */
  private async unclosedShifts(businesses: ScopedBusiness[], now: Date) {
    const cutoff = new Date(now.getTime() - UNCLOSED_SHIFT_HOURS * 3_600_000);
    const branchToBusiness = branchIndex(businesses);
    const rows = await this.scoped.shift.findMany({
      where: {
        branchId: { in: [...branchToBusiness.keys()] },
        closedAt: null,
        openedAt: { lt: cutoff },
      },
      select: { branchId: true },
    });

    const counts = new Map<string, number>();
    for (const business of businesses) counts.set(business.id, 0);
    for (const row of rows) {
      const businessId = branchToBusiness.get(row.branchId);
      if (businessId) counts.set(businessId, (counts.get(businessId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([businessId, count]) => ({
      businessId,
      count,
    }));
  }
}
