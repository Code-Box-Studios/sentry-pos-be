import { IsString, MaxLength } from 'class-validator';

/** Body for `POST /v1/pos/sales/:id/refund` — PIN-gated; reason non-empty (service). */
export class RefundSaleDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsString()
  @MaxLength(100)
  pin!: string;
}
