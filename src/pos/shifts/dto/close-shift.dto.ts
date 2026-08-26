import { IsInt, Max, Min } from 'class-validator';

const MAX_CENTAVOS = 100_000_000;

/** Body for `POST /v1/pos/shifts/current/close` — physically counted drawer cash. */
export class CloseShiftDto {
  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  countedCashC!: number;
}
