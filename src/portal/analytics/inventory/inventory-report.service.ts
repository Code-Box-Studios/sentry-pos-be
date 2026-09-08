import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ValidationFailedError } from '../../../common/errors/api-errors';
import { Paginated } from '../../../common/types/pagination';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { MovementsQueryDto } from '../dto/movements-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import {
  movementsCountSql,
  movementsSql,
  onHandSql,
  shrinkageSql,
  type CountRow,
  type MovementRow,
  type OnHandRow,
  type ShrinkageRow,
} from '../reports/inventory.sql';
import { daysOfStock, isLow, valuationC } from './days-of-stock';

const DEFAULT_PAGE_SIZE = 50;

/**
 * The deepest page the ledger will serve.
 *
 * Reports query per business and merge in TypeScript, so serving page N means
 * fetching N × pageSize rows from EACH business — the global top-N is always a
 * subset of the union of the per-business top-Ns, which is what makes the merge
 * correct. Bounding the product keeps memory predictable; past it the honest
 * answer is "narrow the scope", not a slow query.
 */
const MAX_MERGE_ROWS = 2000;

export interface Movement {
  id: string;
  createdAt: Date;
  branchId: string;
  branchName: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  type: string;
  qtyDelta: number;
  reasonCategory: string | null;
  unitCostC: number | null;
  note: string | null;
  /** From the audit trail; null when no audit row matches this movement. */
  actor: { actorType: string; actorId: string | null; action: string } | null;
}

export interface ShrinkageEntry {
  reasonCategory: string;
  units: number;
  /** Null when NOTHING in this reason bucket had a cost. */
  valueC: number | null;
  uncostedUnits: number;
}

export interface ShrinkageReport {
  from: string;
  to: string;
  rows: ShrinkageEntry[];
}

export interface OnHandEntry {
  branchId: string;
  branchName: string;
  productId: string;
  variantId: string | null;
  name: string;
  qty: number;
  unitCostC: number | null;
  valueC: number | null;
  lowStockThreshold: number | null;
  isLow: boolean;
  daysOfStock: number | null;
}

export interface OnHandReport {
  from: string;
  to: string;
  rows: OnHandEntry[];
  totals: { valueC: number; uncostedItems: number };
}

/** §5 Inventory movements, shrinkage and stock on hand. */
@Injectable()
export class InventoryReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async movements(query: MovementsQueryDto): Promise<Paginated<Movement>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const reach = page * pageSize;
    if (reach > MAX_MERGE_ROWS) {
      throw new ValidationFailedError(
        `page x pageSize must not exceed ${MAX_MERGE_ROWS} — narrow the date range, branch, or product instead.`,
      );
    }

    const scope = await this.scope.resolve(query);
    const filter = { type: query.type, productId: query.productId };

    const rows: Movement[] = [];
    let total = 0;

    for (const business of scope.businesses) {
      const counted = await runScopedOne<CountRow>(this.raw, business, (b) =>
        movementsCountSql(b, filter),
      );
      total += Number(counted.total);

      for (const row of await runScoped<MovementRow>(this.raw, business, (b) =>
        movementsSql(b, filter, reach),
      )) {
        rows.push({
          id: row.id,
          createdAt: row.created_at,
          branchId: row.branch_id,
          branchName: row.branch_name,
          productId: row.product_id,
          variantId: row.variant_id,
          productName: row.product_name,
          variantName: row.variant_name,
          type: row.type,
          qtyDelta: row.qty_delta,
          reasonCategory: row.reason_category,
          unitCostC: row.unit_cost,
          note: row.note,
          actor:
            row.actor_type === null || row.action === null
              ? null
              : {
                  actorType: row.actor_type,
                  actorId: row.actor_id,
                  action: row.action,
                },
        });
      }
    }

    rows.sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
    });

    await this.reportAudit.log(
      scope,
      'inventory-movements',
      query.format ?? 'json',
    );

    return {
      data: rows.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async shrinkage(query: AnalyticsQueryDto): Promise<ShrinkageReport> {
    const scope = await this.scope.resolve(query);
    const merged = new Map<
      string,
      {
        units: number;
        costedRows: number;
        valueC: number;
        uncostedUnits: number;
      }
    >();

    for (const business of scope.businesses) {
      for (const row of await runScoped<ShrinkageRow>(
        this.raw,
        business,
        shrinkageSql,
      )) {
        const current = merged.get(row.reason_category) ?? {
          units: 0,
          costedRows: 0,
          valueC: 0,
          uncostedUnits: 0,
        };
        merged.set(row.reason_category, {
          units: current.units + row.units,
          costedRows: current.costedRows + Number(row.costed_rows),
          valueC: current.valueC + Number(row.value_c),
          uncostedUnits: current.uncostedUnits + row.uncosted_units,
        });
      }
    }

    await this.reportAudit.log(
      scope,
      'inventory-shrinkage',
      query.format ?? 'json',
    );

    return {
      from: scope.from,
      to: scope.to,
      rows: [...merged.entries()]
        .map(([reasonCategory, r]) => ({
          reasonCategory,
          units: r.units,
          valueC: r.costedRows === 0 ? null : r.valueC,
          uncostedUnits: r.uncostedUnits,
        }))
        .sort((a, b) => (b.valueC ?? 0) - (a.valueC ?? 0)),
    };
  }

  async onHand(query: AnalyticsQueryDto): Promise<OnHandReport> {
    const scope = await this.scope.resolve(query);
    const rows: OnHandEntry[] = [];
    let valueC = 0;
    let uncostedItems = 0;

    for (const business of scope.businesses) {
      for (const row of await runScoped<OnHandRow>(
        this.raw,
        business,
        onHandSql,
      )) {
        const value = valuationC(row.qty, row.unit_cost);
        if (value === null) uncostedItems += 1;
        else valueC += value;

        rows.push({
          branchId: row.branch_id,
          branchName: row.branch_name,
          productId: row.product_id,
          variantId: row.variant_id,
          name: row.name,
          qty: row.qty,
          unitCostC: row.unit_cost,
          valueC: value,
          lowStockThreshold: row.low_stock_threshold,
          isLow: isLow(row.qty, row.low_stock_threshold),
          daysOfStock: daysOfStock(row.qty, row.units_sold, scope.dayCount),
        });
      }
    }

    await this.reportAudit.log(
      scope,
      'inventory-on-hand',
      query.format ?? 'json',
    );

    return {
      from: scope.from,
      to: scope.to,
      rows,
      totals: { valueC, uncostedItems },
    };
  }
}
