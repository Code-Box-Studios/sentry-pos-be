import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { ISO_DATE_REGEX } from '../../../common/validation-constants';

/**
 * The query every report endpoint accepts.
 *
 * Range presets (today / 7 days / this month …) resolve in the PORTAL, not
 * here: "today" is a question about a business day, and answering it in one
 * place — against the business's own `dayStartTime` — keeps the API explicit
 * and testable. The API takes literal dates only.
 */
export class AnalyticsQueryDto {
  /** Omit to span every non-demo business the caller owns. */
  @IsOptional()
  @IsUUID()
  businessId?: string;

  /** Requires `businessId`; the resolver rejects it on its own. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Inclusive business-day lower bound. */
  @Matches(ISO_DATE_REGEX, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  /** Inclusive business-day upper bound. */
  @Matches(ISO_DATE_REGEX, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}
