import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const MAX_CENTAVOS = 100_000_000;

/** Body for `PATCH /v1/portal/discounts/:id` — every field optional. */
export class UpdateDiscountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsIn(['percent', 'fixed'])
  kind?: 'percent' | 'fixed';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CENTAVOS)
  value?: number;

  @IsOptional()
  @IsIn(['line', 'order', 'both'])
  appliesTo?: 'line' | 'order' | 'both';

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
