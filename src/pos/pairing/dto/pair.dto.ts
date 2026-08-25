import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/** Body for `POST /v1/pos/pairing/pair`. */
export class PairDto {
  @IsUUID()
  businessId!: string;

  @IsUUID()
  branchId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  terminalName!: string;
}
