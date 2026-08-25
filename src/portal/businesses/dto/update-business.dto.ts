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
 * Body for `PATCH /v1/portal/businesses/:id` — every field optional. Task 14's
 * business settings ride this same endpoint, so the settings-ish fields live
 * here too. Same PHP-only / rate-range rules as create.
 */
export class UpdateBusinessDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsIn(['retail', 'fnb', 'mixed'])
  type?: 'retail' | 'fnb' | 'mixed';

  @IsOptional()
  @IsIn(['PHP'])
  currency?: 'PHP';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.9999)
  taxRate?: number;

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
