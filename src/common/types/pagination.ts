/**
 * Standard paginated response envelope.
 *
 * First introduced for Task 10's admin activity-log browse; the shared home so
 * Task 11+ list endpoints return the same shape.
 */
export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
