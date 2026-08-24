import { IsNotEmpty, IsString } from 'class-validator';

export class TotpVerifyDto {
  @IsString()
  @IsNotEmpty()
  preAuthToken!: string;

  @IsString()
  @IsNotEmpty()
  code!: string;
}
