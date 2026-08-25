import {
  IsEmail,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Body for `POST /v1/admin/owners` — provision a new owner + invite. */
export class CreateOwnerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsEmail()
  email!: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  maxBusinesses!: number;
}
