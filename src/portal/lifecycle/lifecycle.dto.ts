import { Equals, IsUUID } from 'class-validator';
export class CloseAccountDto {
  @Equals('CLOSE MY ACCOUNT') confirmation!: string;
  @IsUUID() exportId!: string;
}
export class ResetDemoDto {
  @Equals('RESET DEMO') confirmation!: string;
  @IsUUID() id!: string;
}
