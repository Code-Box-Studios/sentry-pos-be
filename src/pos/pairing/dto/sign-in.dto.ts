import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for `POST /v1/pos/pairing/sign-in`. */
export class SignInDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}
