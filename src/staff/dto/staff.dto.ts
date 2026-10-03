import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateStaffDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(['manager', 'cashier'])
  role!: 'manager' | 'cashier';

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  branchIds!: string[];
}

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(['manager', 'cashier'])
  role?: 'manager' | 'cashier';

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  branchIds?: string[];
}

export class SetupManagerDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  temporaryPin!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  permanentPin!: string;
}

export class SetupPasswordDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  temporaryPin!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
