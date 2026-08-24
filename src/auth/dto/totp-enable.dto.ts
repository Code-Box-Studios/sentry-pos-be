import { IsNotEmpty, IsString } from 'class-validator';

export class TotpEnableDto {
  @IsString()
  @IsNotEmpty()
  code!: string;
}
