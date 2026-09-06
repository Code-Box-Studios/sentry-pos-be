import { IsIn, IsOptional } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export class SalesTrendQueryDto extends AnalyticsQueryDto {
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  granularity?: 'day' | 'week' | 'month';
}
