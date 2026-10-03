import { IsString, IsUUID, Matches } from 'class-validator';

export class ApprovalDto {
  @IsUUID('4')
  approverUserId!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  pin!: string;
}
