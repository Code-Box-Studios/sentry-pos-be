import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Query filters for `GET /v1/admin/businesses/:id/activity-log`. */
export class ActivityLogQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsIn(['owner', 'terminal', 'platform_admin'])
  actorType?: 'owner' | 'terminal' | 'platform_admin';

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
