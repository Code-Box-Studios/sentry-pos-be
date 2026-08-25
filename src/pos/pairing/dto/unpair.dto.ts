import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for `POST /v1/pos/unpair` (device token in Authorization + owner re-auth). */
export class UnpairDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}
