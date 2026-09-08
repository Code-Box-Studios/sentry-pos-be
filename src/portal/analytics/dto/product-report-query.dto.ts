import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

/** Query for the §3 product reports. */
export class ProductReportQueryDto extends AnalyticsQueryDto {
  /** Ranking key. Defaults to `units`. */
  @IsOptional()
  @IsIn(['units', 'revenue'])
  by?: 'units' | 'revenue';

  /** 1–100, default 20. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
