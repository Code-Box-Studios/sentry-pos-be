import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScopedOne } from '../scoped-sql';
import { taxSummarySql, type TaxRow } from '../reports/tax.sql';

export interface TaxBusinessRow {
  businessId: string;
  name: string;
  taxRate: number;
  vatableSalesC: number;
  vatC: number;
  vatExemptSalesC: number;
  scPwdDiscountC: number;
  serviceChargeC: number;
}

export interface TaxTotals {
  vatableSalesC: number;
  vatC: number;
  vatExemptSalesC: number;
  scPwdDiscountC: number;
  serviceChargeC: number;
}

export interface TaxReport {
  from: string;
  to: string;
  businesses: TaxBusinessRow[];
  totals: TaxTotals;
}

/**
 * Tax summary (analytics-spec §6).
 *
 * A row per business, deliberately: the money columns add up across businesses,
 * but `taxRate` does not — a blended rate is a number that is true of nothing,
 * so `totals` carries no rate at all.
 */
@Injectable()
export class TaxReportService {
  constructor(
    private readonly scope: AnalyticsScopeService,
    private readonly raw: PrismaService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<TaxReport> {
    const scope = await this.scope.resolve(query);
    const businesses: TaxBusinessRow[] = [];
    const totals: TaxTotals = {
      vatableSalesC: 0,
      vatC: 0,
      vatExemptSalesC: 0,
      scPwdDiscountC: 0,
      serviceChargeC: 0,
    };

    for (const business of scope.businesses) {
      const row = await runScopedOne<TaxRow>(this.raw, business, taxSummarySql);
      const mapped: TaxBusinessRow = {
        businessId: business.id,
        name: business.name,
        taxRate: business.taxRate,
        vatableSalesC: Number(row.vatable_sales_c),
        vatC: Number(row.vat_c),
        vatExemptSalesC: Number(row.vat_exempt_sales_c),
        scPwdDiscountC: Number(row.sc_pwd_discount_c),
        serviceChargeC: Number(row.service_charge_c),
      };
      businesses.push(mapped);
      totals.vatableSalesC += mapped.vatableSalesC;
      totals.vatC += mapped.vatC;
      totals.vatExemptSalesC += mapped.vatExemptSalesC;
      totals.scPwdDiscountC += mapped.scPwdDiscountC;
      totals.serviceChargeC += mapped.serviceChargeC;
    }

    await this.reportAudit.log(scope, 'tax', query.format ?? 'json');
    return { from: scope.from, to: scope.to, businesses, totals };
  }
}
