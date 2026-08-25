import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * Query filters for `GET /v1/portal/businesses/:businessId/activity-log`.
 *
 * The BO-facing `actorType` filter accepts only `owner | terminal` — platform
 * rows are never visible to a business owner (the tenancy rule already excludes
 * them), so `platform_admin` is not an accepted value.
 */
export class ActivityLogQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsIn(['owner', 'terminal'])
  actorType?: 'owner' | 'terminal';

  @IsOptional()
  @IsString()
  action?: string;

  /** ISO date-time lower bound (inclusive) on createdAt. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** ISO date-time upper bound (inclusive) on createdAt. */
  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
