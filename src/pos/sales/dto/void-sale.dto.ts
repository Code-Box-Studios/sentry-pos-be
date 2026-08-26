import { IsString, MaxLength } from 'class-validator';

/** Body for `POST /v1/pos/sales/:id/void` — non-empty reason enforced in service. */
export class VoidSaleDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}
