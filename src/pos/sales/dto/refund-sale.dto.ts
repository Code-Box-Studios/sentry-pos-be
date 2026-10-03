import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApprovalDto } from '../../operators/dto/approval.dto';

/** Body for `POST /v1/pos/sales/:id/refund` — PIN-gated; reason non-empty (service). */
export class RefundSaleDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  pin?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalDto)
  approval?: ApprovalDto;
}
