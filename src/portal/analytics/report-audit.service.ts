import { Injectable } from '@nestjs/common';
import { AuditService } from '../../auth/audit.service';
import type { ResolvedScope } from './scope/analytics-scope.service';

/**
 * Report views and exports are sensitive READS (project-spec §11), which the
 * tenancy choke point does not capture — it audits mutations. This writes them
 * explicitly, one row per business in scope, so each business's own activity log
 * shows who looked at its numbers and when.
 */
@Injectable()
export class ReportAuditService {
  constructor(private readonly audit: AuditService) {}

  async log(
    scope: ResolvedScope,
    report: string,
    format: 'json' | 'csv',
  ): Promise<void> {
    const action =
      format === 'csv' ? 'audit.report_export' : 'audit.report_read';

    for (const business of scope.businesses) {
      await this.audit.logPortal(action, 'report', null, business.id, {
        report,
        from: scope.from,
        to: scope.to,
      });
    }
  }
}
