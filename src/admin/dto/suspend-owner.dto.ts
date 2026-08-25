import { IsIn } from 'class-validator';

/**
 * Body for `POST /v1/admin/owners/:id/suspend`.
 *
 * - `default` → status `suspended` (portal locked; open shifts may finish
 *   selling ≤ 24h — the terminal-side grace check lands in Task 16).
 * - `hard`    → status `hard_suspended` (everything dies instantly).
 */
export class SuspendOwnerDto {
  @IsIn(['default', 'hard'])
  tier!: 'default' | 'hard';
}
