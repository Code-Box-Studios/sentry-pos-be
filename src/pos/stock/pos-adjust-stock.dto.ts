import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { AdjustStockDto } from '../../portal/stock/dto/adjust-stock.dto';
import { ApprovalDto } from '../operators/dto/approval.dto';

export class PosAdjustStockDto extends AdjustStockDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalDto)
  approval?: ApprovalDto;
}
