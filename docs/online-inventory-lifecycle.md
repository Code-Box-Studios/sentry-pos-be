# Online inventory and account lifecycle

## Inventory

All paths below start with `/v1/portal/branches/:branchId/stock` and require an active owner token. Product variants hold stock exclusively when present. Quantities have at most three decimal places; monetary API values are integer centavos.

- `POST transfers`: `{id,toBranchId,lines:[{productId,variantId?,qty}],note?}`. Debits and credits owned branches in the same business atomically. `GET transfers` lists both incoming and outgoing transfers.
- `POST counts`: `{id,notes?,items:[{productId,variantId?,countedQty}]}` creates a draft. `PUT counts/:id` replaces draft items and notes. `POST counts/:id/post` snapshots current stock and writes count-correction movements exactly once. Posted counts are immutable. `GET counts` and `GET counts/:id` return quantity/variance history.
- `POST receive` accepts optional client `id` for idempotent receive batches. Expiry products require each line's `expiryDate`.
- `GET expiry` returns `{asOf,warningDays,batches}` for remaining batches inside the business warning window, including already expired stock. Batch rows expose receivedQty, remainingQty, expiryDate, daysLeft and unitCostC.

UUID retries with the same normalized request return the existing result. Reusing a transfer, count-creation or receive UUID with changed details returns 422. Count-creation fingerprints remain unchanged when a draft is subsequently edited. Generate a new request UUID when changing a failed request's details.

Stock writes use scoped/audited Prisma operations inside transactions, serialize portal inventory operations per business, and lock existing stock rows against terminal writes. Count expectedQty is measured at posting, not when the draft was created.

FEFO remaining quantities are estimates derived from total batch receipts and current branch stock, consuming earliest expiry first. They do not allocate individual sales to batches. Transfers carry derived expiry metadata to their destination. Positive unbatched adjustments remain unassigned. Historical batches lacking reliable branch attribution remain nullable and are excluded from branch reports; the migration does not invent a branch.

## Export and closure

- `GET /v1/portal/account/export` returns a ZIP attachment and `X-Export-Id`. CSVs share the reporting CSV writer, use typed column keys, exclude credentials/session identifiers, and include archived/demo data. `README.txt` documents pesos columns and centavos in nested JSON. Export includes profile, users, business settings, branches, catalog/variants/categories/modifiers/groups/links/discounts, terminals, sales/items/payments, shifts/cash movements, stock/movements/counts/batches, notifications and the owner's activity log.
- `POST /v1/portal/account/closure` requires `{confirmation:"CLOSE MY ACCOUNT",exportId}` referencing this owner's export from the preceding 24 hours. Response `{closedAt,purgeAfter}` records a 90-day grace period and immediately closes owner access, revokes refresh tokens and unpairs devices. Ordinary admin suspension/reinstatement cannot override closure.
- `POST /v1/portal/businesses/:id/demo-reset` requires `{id,confirmation:"RESET DEMO"}`. It archives only the owned demo, unpairs its devices, and returns a freshly seeded `{businessId}`. Exact request retries return the replacement ID. Immutable historical audit remains available until account end-of-life.

Exports currently build a ZIP in memory within a 60-second repeatable-read transaction. Plan streaming/background archive generation before accepting very large tenants. ZIPs contain image references rather than image bytes.

## System jobs and administrator access

Background jobs run unless `JOBS_ENABLED=false` or `NODE_ENV=test`. Account purges run on startup and hourly, process at most 50 due owners per tick, and check both closedAt + 90 days and purgeAfter. The database trigger independently enforces this boundary for the sole audit-deletion exception; audit UPDATE remains forbidden. A failing tenant does not block other due tenants.

Object keys are committed into durable `purge-media:` manifests before database deletion, then removed from configured tenant storage after commit. `media-cleanup:` manifests use the same retry worker for replaced/orphan images. Missing storage configuration or deletion failures retain the manifest; jobs are ordered by updatedAt/id so failures rotate behind other work. Configure storage and monitor `job_deliveries.last_error` to complete external-object erasure.

`GET /v1/admin/metrics` provides owner/status and operational counts. `GET /v1/admin/businesses/:id/inspect?section=...&page=1&pageSize=50` is read-only, paginated and audited. Allowed sections: catalog, sales, payments, shifts, stock, counts, terminals. Terminal device-token hashes and sale draft credentials are not exposed.
