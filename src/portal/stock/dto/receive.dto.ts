import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const MAX_CENTAVOS = 100_000_000;
const MAX_QTY = 1_000_000;

/** One received line: +qty of a product (or a specific variant). */
export class ReceiveLineDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(MAX_QTY)
  qty!: number;

  /** Latest unit cost in centavos; overwrites the product/variant cost (§6). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  unitCostC?: number;

  /** Expiry date (ISO) for track_expiry products; records a stock batch. */
  @IsOptional()
  @IsISO8601()
  expiryDate?: string;
}

/** Body for `POST /v1/portal/branches/:branchId/stock/receive`. */
export class ReceiveDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
}
