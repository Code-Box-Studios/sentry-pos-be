import { Inject, Injectable } from '@nestjs/common';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../../prisma/scoped-prisma.provider';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../../common/errors/api-errors';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import {
  addDays,
  businessDayOf,
  businessDayRangeUtc,
  businessDaySeries,
  businessDayStartUtc,
  parseDayStart,
  previousPeriod,
} from './business-day';

const MAX_RANGE_DAYS = 366;

export interface ScopedBusiness {
  id: string;
  name: string;
  dayStartTime: string;
  dayStartMinutes: number;
  taxRate: number;
  branchIds: string[];
  fromUtc: Date;
  toUtc: Date;
  previousFromUtc: Date;
  previousToUtc: Date;
}

export interface ResolvedScope {
  businesses: ScopedBusiness[];
  branchIds: string[];
  from: string;
  to: string;
  dayCount: number;
}

/**
 * Turns a report query into the branches and UTC windows the SQL will use.
 *
 * Ids are resolved through the SCOPED client, so the tenancy choke point — not
 * this service — decides what the caller may see. That matters more than usual
 * here: the report queries themselves are raw SQL, which bypasses the choke
 * point entirely, so this is where their scope comes from.
 *
 * The window lives on each BUSINESS rather than on the scope, because
 * `dayStartTime` differs per business: a midnight retailer and an 04:00 cafe
 * asked about the same dates are asking about different UTC intervals. Every
 * report therefore queries per business and merges in TypeScript.
 *
 * 404 is reserved for a named id that is not the caller's. An owned business
 * that simply has no branches yet yields an empty list and a zeroed report — a
 * new business is a legitimate thing to ask about.
 */
@Injectable()
export class AnalyticsScopeService {
  constructor(@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma) {}

  async resolve(query: AnalyticsQueryDto): Promise<ResolvedScope> {
    if (query.branchId && !query.businessId) {
      throw new ValidationFailedError(
        'branchId requires businessId — a branch is only meaningful within its business.',
      );
    }

    let days: string[];
    try {
      days = businessDaySeries(query.from, query.to);
    } catch {
      throw new ValidationFailedError('to must be on or after from.');
    }
    if (days.length > MAX_RANGE_DAYS) {
      throw new ValidationFailedError(
        `The date range must not exceed ${MAX_RANGE_DAYS} days.`,
      );
    }

    const businesses = await this.scoped.business.findMany({
      // Demo businesses are excluded from rollups (project-spec §8) but remain
      // reportable when asked for by id, so training data can still be checked.
      where: query.businessId ? { id: query.businessId } : { isDemo: false },
      select: { id: true, name: true, dayStartTime: true, taxRate: true },
      orderBy: { createdAt: 'asc' },
    });
    if (businesses.length === 0) {
      throw new NotFoundError('Business not found.');
    }

    const branches = await this.scoped.branch.findMany({
      where: {
        businessId: { in: businesses.map((b) => b.id) },
        ...(query.branchId ? { id: query.branchId } : {}),
      },
      select: { id: true, businessId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (query.branchId && branches.length === 0) {
      throw new NotFoundError('Branch not found.');
    }

    const byBusiness = new Map<string, string[]>();
    for (const branch of branches) {
      const list = byBusiness.get(branch.businessId);
      if (list) list.push(branch.id);
      else byBusiness.set(branch.businessId, [branch.id]);
    }

    const scopedBusinesses: ScopedBusiness[] = [];
    for (const business of businesses) {
      const branchIds = byBusiness.get(business.id);
      if (!branchIds || branchIds.length === 0) continue;

      const dayStartMinutes = parseDayStart(business.dayStartTime);
      const { fromUtc, toUtc } = businessDayRangeUtc(
        query.from,
        query.to,
        dayStartMinutes,
      );
      const previous = previousPeriod(fromUtc, toUtc);

      scopedBusinesses.push({
        id: business.id,
        name: business.name,
        dayStartTime: business.dayStartTime,
        dayStartMinutes,
        taxRate: Number(business.taxRate),
        branchIds,
        fromUtc,
        toUtc,
        previousFromUtc: previous.fromUtc,
        previousToUtc: previous.toUtc,
      });
    }

    return {
      businesses: scopedBusinesses,
      branchIds: scopedBusinesses.flatMap((b) => b.branchIds),
      from: query.from,
      to: query.to,
      dayCount: days.length,
    };
  }

  /**
   * The dashboard's scope: every non-demo business, each windowed on ITS OWN
   * today.
   *
   * "Today" is not one date across a tenant — at 3 AM a midnight retailer is
   * already on the new business day while an 04:00 cafe is still on yesterday's.
   * So each business gets `businessDayOf(now, its own day start)`.
   *
   * `previousFromUtc`/`previousToUtc` here mean the SAME BUSINESS DAY ONE WEEK
   * EARLIER, not the immediately preceding period — that is the comparison
   * analytics-spec §0 asks for, and weekday-to-weekday is the only fair one for
   * a single day.
   *
   * `from`/`to` carry the first business's today and exist only so the audit
   * rows say which day was viewed.
   */
  async resolveToday(now: Date): Promise<ResolvedScope> {
    const businesses = await this.scoped.business.findMany({
      where: { isDemo: false },
      select: { id: true, name: true, dayStartTime: true, taxRate: true },
      orderBy: { createdAt: 'asc' },
    });
    const branches = await this.scoped.branch.findMany({
      where: { businessId: { in: businesses.map((b) => b.id) } },
      select: { id: true, businessId: true },
      orderBy: { createdAt: 'asc' },
    });

    const byBusiness = new Map<string, string[]>();
    for (const branch of branches) {
      const list = byBusiness.get(branch.businessId);
      if (list) list.push(branch.id);
      else byBusiness.set(branch.businessId, [branch.id]);
    }

    const scopedBusinesses: ScopedBusiness[] = [];
    for (const business of businesses) {
      const branchIds = byBusiness.get(business.id);
      if (!branchIds || branchIds.length === 0) continue;

      const dayStartMinutes = parseDayStart(business.dayStartTime);
      const today = businessDayOf(now, dayStartMinutes);
      const lastWeek = addDays(today, -7);

      scopedBusinesses.push({
        id: business.id,
        name: business.name,
        dayStartTime: business.dayStartTime,
        dayStartMinutes,
        taxRate: Number(business.taxRate),
        branchIds,
        fromUtc: businessDayStartUtc(today, dayStartMinutes),
        toUtc: businessDayStartUtc(addDays(today, 1), dayStartMinutes),
        previousFromUtc: businessDayStartUtc(lastWeek, dayStartMinutes),
        previousToUtc: businessDayStartUtc(
          addDays(lastWeek, 1),
          dayStartMinutes,
        ),
      });
    }

    const first = scopedBusinesses[0];
    const stamp = businessDayOf(now, first ? first.dayStartMinutes : 0);

    return {
      businesses: scopedBusinesses,
      branchIds: scopedBusinesses.flatMap((b) => b.branchIds),
      from: stamp,
      to: stamp,
      dayCount: 1,
    };
  }
}
