import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { HHMM_REGEX } from '../../../common/validation-constants';

/**
 * Body for `POST /v1/portal/businesses`.
 *
 * §7: currency is PHP-only. Rates are fractions in [0, 1) (the schema stores
 * Decimal(5,4), so 0.9999 is the practical ceiling). `ownerId` and `isDemo` are
 * deliberately absent — ownerId is forced by the tenancy choke point and isDemo
 * is reserved for demo provisioning; the ValidationPipe whitelist strips either
 * if a client sends them.
 */
export class CreateBusinessDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsIn(['retail', 'fnb', 'mixed'])
  type!: 'retail' | 'fnb' | 'mixed';

  @IsOptional()
  @IsIn(['PHP'])
  currency?: 'PHP';

  @IsNumber()
  @Min(0)
  @Max(0.9999)
  taxRate!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.9999)
  serviceChargeRate?: number;

  @IsOptional()
  @Matches(HHMM_REGEX, { message: 'dayStartTime must be HH:mm (24-hour)' })
  dayStartTime?: string;

  @IsOptional()
  @IsBoolean()
  allowMiscItems?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  expiryWarningDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  receiptHeader?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  receiptFooter?: string;
}
