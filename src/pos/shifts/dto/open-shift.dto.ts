import { IsInt, Max, Min } from 'class-validator';

const MAX_CENTAVOS = 100_000_000;

/** Body for `POST /v1/pos/shifts` — opening cash float in centavos. */
export class OpenShiftDto {
  @IsInt()
  @Min(0)
  @Max(MAX_CENTAVOS)
  openingCashC!: number;
}
