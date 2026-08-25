import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BRANCH_CODE_REGEX } from '../../../common/validation-constants';

/** Body for `PATCH /v1/portal/branches/:id` — every field optional. */
export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(BRANCH_CODE_REGEX, {
    message: 'code must be 2–6 uppercase letters or digits',
  })
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  address?: string;
}
