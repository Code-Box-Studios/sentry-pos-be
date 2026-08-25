import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * Body for `PUT /v1/portal/products/:id/modifier-groups` — the FULL desired set
 * of linked modifier-group ids (replace-set). An empty array clears all links.
 */
export class SetProductModifierGroupsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  groupIds!: string[];
}
