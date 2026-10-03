import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApprovalDto } from '../../operators/dto/approval.dto';

/** Body for `POST /v1/pos/sales/:id/void` — non-empty reason enforced in service. */
export class VoidSaleDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalDto)
  approval?: ApprovalDto;
}
