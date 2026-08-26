import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

const MAX_CENTAVOS = 100_000_000;

/** Body for `POST /v1/pos/shifts/current/cash-movements`. */
export class CashMovementDto {
  @IsIn(['in', 'out'])
  type!: 'in' | 'out';

  @IsInt()
  @Min(1)
  @Max(MAX_CENTAVOS)
  amountC!: number;

  // Non-empty is enforced in the service after trimming (mirrors the FE mock).
  @IsString()
  @MaxLength(200)
  reason!: string;
}
