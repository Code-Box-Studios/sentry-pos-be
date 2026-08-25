import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const MAX_CENTAVOS = 100_000_000;

/**
 * A single modifier in a group's replace-set. `id` is present only when updating
 * an existing modifier (PATCH); omit it to create. `priceDeltaC` is centavos
 * (may be negative for a price-reducing modifier) mapped to `priceDelta`.
 */
export class ModifierInputDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(-MAX_CENTAVOS)
  @Max(MAX_CENTAVOS)
  priceDeltaC!: number;
}

/**
 * Body for `POST /v1/portal/businesses/:businessId/modifier-groups`.
 * `minSelect` must be ≤ `maxSelect` (enforced in the service). `modifiers` is the
 * full desired list (replace-set semantics on update).
 */
export class CreateModifierGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  minSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxSelect?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ModifierInputDto)
  modifiers?: ModifierInputDto[];
}
