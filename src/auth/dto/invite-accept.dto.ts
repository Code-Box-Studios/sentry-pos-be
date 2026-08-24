import { IsString, MinLength } from 'class-validator';

export class InviteAcceptDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
