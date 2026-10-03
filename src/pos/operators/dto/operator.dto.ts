import { IsString, IsUUID, Matches } from 'class-validator';

export class UnlockOperatorDto {
  @IsUUID('4') userId!: string;
  @IsString() @Matches(/^\d{6}$/) pin!: string;
}

export class SetupOperatorPinDto {
  @IsUUID('4') userId!: string;
  @IsString() @Matches(/^\d{6}$/) temporaryPin!: string;
  @IsString() @Matches(/^\d{6}$/) newPin!: string;
}
