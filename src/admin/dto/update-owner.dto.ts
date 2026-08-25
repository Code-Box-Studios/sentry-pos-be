import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Body for `PATCH /v1/admin/owners/:id` — both fields optional. */
export class UpdateOwnerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxBusinesses?: number;
}
