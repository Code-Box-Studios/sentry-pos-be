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

/**
 * Body for `POST /v1/portal/businesses/:businessId/discounts`.
 *
 * `value` is dual-purpose per `kind`: for `percent` it is 1–100 (enforced in the
 * service); for `fixed` it is centavos. `appliesTo` is line/order/both.
 */
export class CreateDiscountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsIn(['percent', 'fixed'])
  kind!: 'percent' | 'fixed';

  @IsInt()
  @Min(1)
  @Max(MAX_CENTAVOS)
  value!: number;

  @IsIn(['line', 'order', 'both'])
  appliesTo!: 'line' | 'order' | 'both';

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
