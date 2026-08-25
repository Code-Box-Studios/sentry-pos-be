import { Matches } from 'class-validator';

/** Body for `PUT /v1/portal/refund-pin` — exactly 6 digits. */
export class SetRefundPinDto {
  @Matches(/^\d{6}$/, { message: 'pin must be exactly 6 digits' })
  pin!: string;
}
