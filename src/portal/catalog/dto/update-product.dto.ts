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
import { VariantInputDto } from './create-product.dto';

const MAX_CENTAVOS = 100_000_000;

/**
 * Body for `PATCH /v1/portal/products/:id` — every field optional.
 *
 * When `variants` is present it is treated as the FULL desired list
 * (replace-set): entries with an `id` update, without an `id` create, and any
 * existing variant absent from the list is soft-deleted. Omit `variants` to
 * leave them untouched.
 */
export class UpdateProductDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  priceC?: number;

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
