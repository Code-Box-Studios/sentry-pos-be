import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ReceiveLineDto } from './receive.dto';

export class TransferDto {
  @IsUUID() id!: string;
  @IsUUID() toBranchId!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
}
export class CountItemDto {
  @IsUUID() productId!: string;
  @IsOptional() @IsUUID() variantId?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(1000000) countedQty!: number;
}
export class UpdateCountDto {
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CountItemDto)
  items!: CountItemDto[];
}
export class CreateCountDto extends UpdateCountDto {
  @IsUUID() id!: string;
}
