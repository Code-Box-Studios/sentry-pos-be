import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { MovementType } from '@prisma/client';
import { AnalyticsQueryDto } from './analytics-query.dto';

const MOVEMENT_TYPES = [
  'sale',
  'void',
  'refund',
  'adjustment',
  'receive',
  'transfer_out',
  'transfer_in',
] as const;

/** Query for the §5 movement ledger. */
export class MovementsQueryDto extends AnalyticsQueryDto {
  @IsOptional()
  @IsIn(MOVEMENT_TYPES)
  type?: MovementType;

  @IsOptional()
  @IsUUID()
  productId?: string;

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
