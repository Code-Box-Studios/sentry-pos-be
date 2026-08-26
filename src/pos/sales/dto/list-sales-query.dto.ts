import { IsOptional, Matches } from 'class-validator';

/** Query for `GET /v1/pos/sales?date=YYYY-MM-DD` (Manila-day filter). */
export class ListSalesQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
