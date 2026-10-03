import { Type } from 'class-transformer';
import {
  IsDefined,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApprovalDto } from '../../operators/dto/approval.dto';
import { CloseShiftDto } from './close-shift.dto';

export class EmergencyCloseDto extends CloseShiftDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => ApprovalDto)
  approval!: ApprovalDto;
}
