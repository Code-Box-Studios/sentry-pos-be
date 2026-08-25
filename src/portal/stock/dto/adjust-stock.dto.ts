import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const MAX_QTY = 1_000_000;

/**
 * Body for `POST /v1/portal/branches/:branchId/stock/adjustments`.
 * `newQty` is the ABSOLUTE target level (>= 0); the service records the delta.
 */
export class AdjustStockDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(MAX_QTY)
  newQty!: number;

  @IsIn(['damage', 'expiry', 'theft_loss', 'count_correction', 'other'])
  reasonCategory!:
    'damage' | 'expiry' | 'theft_loss' | 'count_correction' | 'other';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
