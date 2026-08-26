import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsBoolean,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type {
  CartModifier,
  DiscountSpec,
  ScPwdInfo,
} from '../../../common/totals/cart';
import type { CartTotals } from '../../../common/totals/totals';

const MAX_CENTAVOS = 100_000_000;
const MAX_QTY = 1_000_000;

/** One chosen modifier snapshot on a cart line. */
export class CartModifierDto implements CartModifier {
  @IsString()
  groupId!: string;

  @IsString()
  modifierId!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(-MAX_CENTAVOS)
  @Max(MAX_CENTAVOS)
  priceDeltaC!: number;
}

/** One cart line (mirrors the FE `CartLine`). */
export class CartLineDto {
  @IsUUID()
  id!: string;

  // null = misc line; a UUID otherwise.
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  productId!: string | null;

  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  variantId!: string | null;

  @IsString()
  @MaxLength(300)
  name!: string;

  @IsIn(['unit', 'weight'])
  soldBy!: 'unit' | 'weight';

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(MAX_QTY)
  qty!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  unitPriceC!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartModifierDto)
  modifiers!: CartModifierDto[];

  // Opaque DiscountSpec | null — recomputed server-side, kept verbatim in the draft.
  @Allow()
  discount!: DiscountSpec | null;

  @IsBoolean()
  scPwdMarked!: boolean;

  @IsBoolean()
  trackStock!: boolean;
}

/** The single payment on a sale (client-generated id; §5.2). */
export class SalePaymentDto {
  @IsUUID()
  id!: string;

  @IsIn(['cash', 'card', 'gcash', 'maya', 'other'])
  method!: 'cash' | 'card' | 'gcash' | 'maya' | 'other';

  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(200)
  referenceNo!: string | null;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  amountC!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  tenderedC!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  changeC!: number;
}

/**
 * The FE `SaleDraft`, accepted verbatim. `totals`, `orderDiscount`, `scPwd` and
 * each line's `discount` are `@Allow`ed (kept exactly as sent, not whitelisted)
 * because the server recomputes the totals and stores the whole draft as the
 * CompletedSale source of truth.
 */
export class SaleDraftDto {
  @IsUUID()
  id!: string;

  @IsString()
  @MaxLength(120)
  receiptNo!: string;

  @IsUUID()
  shiftId!: string;

  @IsIn(['dine_in', 'takeout', 'none'])
  orderType!: 'dine_in' | 'takeout' | 'none';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines!: CartLineDto[];

  @Allow()
  orderDiscount!: DiscountSpec | null;

  @Allow()
  scPwd!: ScPwdInfo | null;

  @Allow()
  totals!: CartTotals;

  @ValidateNested()
  @Type(() => SalePaymentDto)
  payment!: SalePaymentDto;

  @IsISO8601()
  createdAtDevice!: string;
}
