import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
export class InspectQueryDto {
  @IsOptional()
  @IsIn([
    'catalog',
    'sales',
    'payments',
    'shifts',
    'stock',
    'counts',
    'terminals',
  ])
  section:
    | 'catalog'
    | 'sales'
    | 'payments'
    | 'shifts'
    | 'stock'
    | 'counts'
    | 'terminals' = 'catalog';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 50;
}
