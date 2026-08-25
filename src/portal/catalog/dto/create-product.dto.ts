import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Max centavos value (~₱1,000,000) — guards against overflow / fat-finger. */
const MAX_CENTAVOS = 100_000_000;

/**
 * A single variant in a product's replace-set. `id` is present only when
 * updating an existing variant (PATCH); omit it to create a new one.
 */
export class VariantInputDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  priceC!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  costC?: number;
}

/**
 * Body for `POST /v1/portal/businesses/:businessId/products`.
 *
 * `priceC`/`costC` are centavos (integers) mapped to the schema's price/cost.
 * `variants` is the full desired list (replace-set semantics). SKU/barcode
 * uniqueness spans both products AND variants across the business (§6).
 */
export class CreateProductDto {
  @IsUUID()
  categoryId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  priceC!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  costC?: number;

  @IsOptional()
  @IsIn(['unit', 'weight'])
  soldBy?: 'unit' | 'weight';

  @IsOptional()
  @IsNumber()
  @Min(0)
  lowStockThreshold?: number;

  @IsOptional()
  @IsBoolean()
  trackStock?: boolean;

  @IsOptional()
  @IsBoolean()
  trackExpiry?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imagePath?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => VariantInputDto)
  variants?: VariantInputDto[];
}
