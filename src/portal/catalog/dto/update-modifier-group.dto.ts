import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ModifierInputDto } from './create-modifier-group.dto';

/**
 * Body for `PATCH /v1/portal/modifier-groups/:id` — every field optional. When
 * `modifiers` is present it replaces the set (id → update, no id → create, absent
 * → soft-delete). Omit it to leave modifiers untouched.
 */
export class UpdateModifierGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

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
