import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { BRANCH_CODE_REGEX } from '../../../common/validation-constants';

/** Body for `POST /v1/portal/businesses/:businessId/branches`. */
export class CreateBranchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @Matches(BRANCH_CODE_REGEX, {
    message: 'code must be 2–6 uppercase letters or digits',
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  address!: string;
}
