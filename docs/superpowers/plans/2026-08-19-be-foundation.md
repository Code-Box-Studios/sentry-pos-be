# Sentry API Foundation Implementation Plan (sentry-pos-be)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the NestJS API for milestones 1–2: full schema + migrations, tenancy + audit choke point, auth (JWT, TOTP for platform admin, invites/resets via Resend, throttle/lockout), the `/admin/*` and `/portal/*` surfaces needed to provision and configure a business, and the complete `/pos/*` surface that replaces the POS terminal's mock adapter.

**Architecture:** NestJS 11 + Prisma 6 on PostgreSQL (Supabase in cloud; Docker Postgres locally). Every request resolves into exactly one of two contexts — tenant or platform — carried in AsyncLocalStorage; a single Prisma client extension enforces scope filters, blocks tenant writes from platform context, and writes the append-only audit row for every mutation (project-spec §4 + §11: one choke point, nothing bypasses it). Money math is a pure ported copy of the FE totals engine (integer centavos, half-up, round-per-line) — the server recomputes and validates every sale draft. The API publishes OpenAPI via @nestjs/swagger; the FE later generates its typed client from it, and the `/pos/*` contract mirrors the FE plan's `PosApi` interface field-for-field so the HTTP adapter drops in without UI changes.

**Tech Stack:** NestJS 11 (Express) · Prisma 6 · PostgreSQL 16 · TypeScript 5 strict · Passport JWT · argon2 · otplib (TOTP) · Resend · @nestjs/swagger · class-validator/class-transformer · Jest 29 + supertest (e2e against a real Postgres).

## Global Constraints

- **TypeScript everywhere, `strict: true`. No `.js` source files.** (project-spec §3)
- **Supabase = managed Postgres only.** Prisma is the only DB client; migrations use `directUrl` (port 5432). No Supabase Auth/PostgREST/`supabase-js`. (project-spec §3)
- **All money columns are integer centavos** (`Int`); quantity columns are `Decimal(10,3)`. DTO fields use the FE naming convention (`openingCashC`, `totalC`, …) — DB columns stay snake_case per the spec tables. (project-spec §6–7)
- **Money rules:** half-up at every money-producing step; round per line then sum; VAT-inclusive prices, included VAT = `total × rate ÷ (1 + rate)`; SC/PWD = VAT off first then 20%, higher-of vs promo, never both; service charge = `round(rate × discounted subtotal)`, dine-in only; no cash rounding. (project-spec §7)
- **Timestamps stored as UTC; server clock is authoritative; `created_at_device` recorded alongside.** Manila rendering is a client concern; the API's only timezone logic is the Manila-day filter on sales listing and day-boundary math. (project-spec §7)
- **Client-generated UUIDs on all up-sync tables** (sales, sale_items, sale_payments, stock_movements, shift events); the server upserts idempotently — a retried `completeSale` with the same sale id returns the existing sale, never double-posts. (project-spec §5)
- **Every table:** `id uuid PK, created_at, updated_at, deleted_at` (soft deletes). `audit_logs` is append-only and immutable — enforced in the Prisma wrapper AND by a Postgres trigger. (project-spec §6, §11)
- **BO sovereignty:** within their businesses the BO is never permission-gated — the only gates are the refund PIN, `qty >= 0`, and the audit log. Platform context can read all tenant data but any tenant-table write from platform context throws. No impersonation. (project-spec §2, §4)
- **Git workflow (user directive):** work directly on `main`; after each task `git add -A && git commit -m "..." && git push origin main`. **Never add a Claude co-author trailer.** First commit runs `git branch -M main` and `git push -u origin main`.
- **Contract parity:** the `/pos/*` DTOs and error semantics MUST match the FE plan (`sentry-pos-fe/docs/superpowers/plans/2026-08-19-pos-terminal-mvp.md`, Tasks 5–6): same field names, same PIN-lockout sequence (4 × `pin_invalid` with `attemptsRemaining` 3→2→1→0, then `pin_locked` with `retryAfterSeconds`), same stock-conflict shape, terminal codes never reused, `receiptSeq` returned at pairing. Task 21 contains the full mapping table. **Prisma `Decimal` columns (`taxRate`, `serviceChargeRate`, `lowStockThreshold`, `qty`, `qtyDelta`) MUST serialize as JSON numbers in every DTO** — convert via `.toNumber()` in the DTO mapping and pass `Number(...)` into `computeTotals`; never let a Decimal object reach `res.json` (default serialization emits strings and silently breaks the FE). Two documented divergences from the mock, both server-side strengthenings: sign-in returns 401 `login_invalid {attemptsRemaining}` / 423 `login_locked` (the FE mock throws code `validation` on bad creds) — the future HTTP adapter maps these (noted in Task 21 and "After this plan").
- **Deferred (NOT in this plan):** portal/admin frontends (they live in `sentry-pos-fe`), Analytics endpoints + CSV exports + daily summary emails + notifications (milestone 3), `/sync/*` (milestone 4), staff phase. The schema still ships complete — including `notifications`, `stock_counts`, `stock_batches` — because milestone 1 is "schema + migrations". Also deferred to milestone 3: **image/logo upload + signed-URL reads** (Supabase Storage per §3 — `image_path`/`logo_path` ship in the schema but no endpoint sets them; omit both from portal DTOs until then) and **demo-business reset-to-seed** (§8).
- All commands run from the repo root `sentry-pos-be/` unless shown otherwise.

## Repo File Map (end state)

```
sentry-pos-be/
  project-spec.md … landing-spec.md      # staged, Task 1 commits
  docs/superpowers/plans/                 # this plan
  docker-compose.yml                      # postgres:16 for dev + test
  .env / .env.example
  prisma/
    schema.prisma
    migrations/                           # incl. raw SQL: qty>=0 check, audit trigger, partial uniques
    seed.ts                               # platform admin + dev tenant (Kape Diaria parity with FE mock)
  src/
    main.ts  app.module.ts
    config/env.validation.ts
    common/
      context/request-context.ts          # AsyncLocalStorage store + middleware
      errors/api-errors.ts                # typed HttpExceptions with stable `code`s
      totals/totals.ts                    # ported money engine (+ money.ts, qty.ts helpers)
      lockout/lockout.service.ts
    prisma/
      prisma.service.ts                   # raw client (platform + system use)
      scoped-prisma.ts                    # THE tenancy + audit extension
      model-scope-map.ts
    auth/                                 # strategies, guards, login/refresh, totp, invites, resets
    mail/                                 # Resend + dev console transport
    admin/                                # owners CRUD, suspend, tenant read-only browse, admin log
    portal/
      businesses/ branches/ catalog/ discounts/ settings/ stock/ terminals/ activity-log/
    pos/
      pairing/ catalog/ shifts/ sales/ stock/
    health/health.controller.ts
  test/                                   # e2e suites (supertest), helpers/factories
```

---

### Task 1: Repo scaffold — Nest app, config validation, Docker Postgres, health, Jest

**Files:**
- Commit staged: `project-spec.md`, `pos-spec.md`, `design-spec.md`, `staff-spec.md`, `analytics-spec.md`, `landing-spec.md`
- Create: Nest app (via CLI), `docker-compose.yml`, `.env` + `.env.example`, `src/config/env.validation.ts`, `src/health/health.controller.ts`, `.gitignore` additions
- Test: `test/health.e2e-spec.ts`

**Interfaces:**
- Produces: running app on port 4000 with global prefix `v1`; `GET /v1/health` → `{ ok: true }`; validated env (`DATABASE_URL`, `DIRECT_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_PAIRING_SECRET`, `RESEND_API_KEY?`, `MAIL_FROM?`, `CORS_ORIGINS`, `PORT?`); npm scripts `start:dev`, `build`, `lint`, `test`, `test:e2e`, `db:up`, `db:down`.

- [ ] **Step 1: First commit on main**

```bash
cd sentry-pos-be
printf 'node_modules/\ndist/\n.env\n' > .gitignore
git add -A && git commit -m "docs: add spec documents" && git branch -M main && git push -u origin main
```

- [ ] **Step 2: Scaffold** — `npx @nestjs/cli@11 new . --skip-git --package-manager npm` (pin the CLI major; `nest new` into the current dir keeps the staged specs). Confirm `tsconfig.json` has `"strict": true` — the Nest scaffold enables `strictNullChecks` only; set the full `"strict": true` and fix any fallout. Then `npm i @nestjs/config class-validator class-transformer` .

- [ ] **Step 3: Docker Postgres + env**

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    ports: ["54329:5432"]
    environment:
      POSTGRES_USER: sentry
      POSTGRES_PASSWORD: sentry
      POSTGRES_DB: sentry_pos_dev
    volumes: [dbdata:/var/lib/postgresql/data]
volumes: { dbdata: {} }
```

Add scripts: `"db:up": "docker compose up -d db"`, `"db:down": "docker compose down"`. `.env.example` (and `.env`):

```
DATABASE_URL=postgresql://sentry:sentry@localhost:54329/sentry_pos_dev
DIRECT_URL=postgresql://sentry:sentry@localhost:54329/sentry_pos_dev
JWT_ACCESS_SECRET=dev-access-secret-change-me
JWT_REFRESH_SECRET=dev-refresh-secret-change-me
JWT_PAIRING_SECRET=dev-pairing-secret-change-me
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
# RESEND_API_KEY=       # unset in dev → mail logs to console
# MAIL_FROM=Sentry <no-reply@example.com>
PORT=4000
```

(No Docker on the machine? Point both URLs at a Supabase staging project instead — everything else is identical. In production on Supabase, `DATABASE_URL` is the pooled connection and `DIRECT_URL` the direct 5432 connection per project-spec §3.)

`src/config/env.validation.ts` — class-validator-based `validate()` for the vars above (secrets min length 16; `CORS_ORIGINS` comma list), wired via `ConfigModule.forRoot({ isGlobal: true, validate })`.

**Test infrastructure** (every e2e suite from Task 2 on depends on this): `.env.test` pointing `DATABASE_URL`/`DIRECT_URL` at `sentry_pos_test` on the same container; `test/global-setup.ts` (wired as the jest-e2e `globalSetup`) creates that database if missing and runs `npx prisma migrate deploy` against it; `test/helpers/db.ts` exports `resetDb()` (TRUNCATE all tables RESTART IDENTITY CASCADE, excluding `_prisma_migrations`) called from each suite's `beforeEach`, plus shared factory helpers as they accrue. The e2e jest config sets `maxWorkers: 1` (all suites share one DB). The dev DB (`sentry_pos_dev`, seeded in Task 22) is never touched by tests, so the manual smoke and `test:e2e` can pass simultaneously.

- [ ] **Step 4: main.ts + health** — global prefix `v1`; `app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))`; CORS from `CORS_ORIGINS`. `HealthController`: `@Get("health")` → `{ ok: true }`. e2e test boots the app with supertest and asserts `GET /v1/health` → 200 `{ ok: true }`.

- [ ] **Step 5: Verify** — `npm run lint`, `npm run build`, `npm run test:e2e` all green (unit `npm test` may have zero suites yet; keep the scaffold's app.controller spec or delete controller+spec together).

- [ ] **Step 6: Commit & push** — `git add -A && git commit -m "feat(api): scaffold Nest app with validated env, docker postgres, health endpoint" && git push origin main`

---

### Task 2: Prisma schema (§6 complete) + constraints + PrismaService

**Files:**
- Create: `prisma/schema.prisma`, first migration (+ raw SQL), `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`
- Test: `test/schema.e2e-spec.ts`

**Interfaces:**
- Produces: the full database; `PrismaService extends PrismaClient` (global module) — the RAW client, used only by auth/system code and wrapped by Task 4 for everything else.

- [ ] **Step 1: Install + init** — `npm i prisma@6 -D && npm i @prisma/client@6`, `npx prisma init` (keep our `.env`).

- [ ] **Step 2: Write `prisma/schema.prisma`** — every model gets `id String @id @default(uuid()) @db.Uuid`, `createdAt DateTime @default(now()) @map("created_at")`, `updatedAt DateTime @updatedAt @map("updated_at")`, `deletedAt DateTime? @map("deleted_at")`, `@@map("snake_case_table")`; all field names `@map`ped to snake_case. Money = `Int` centavos; quantities = `Decimal @db.Decimal(10, 3)`.

```prisma
generator client { provider = "prisma-client-js" }

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

enum OwnerStatus { active suspended hard_suspended closed }
enum UserRole { platform_admin owner }
enum BusinessType { retail fnb mixed }
enum SoldBy { unit weight }
enum DiscountKind { percent fixed }
enum DiscountAppliesTo { line order both }
enum MovementType { sale void refund adjustment receive transfer_out transfer_in }
enum ReasonCategory { damage expiry theft_loss count_correction other }
enum CashMovementType { cash_in @map("in")  cash_out @map("out") }
enum CountStatus { draft posted }
enum OrderType { dine_in takeout none }
enum SaleStatus { completed voided refunded }
enum PaymentMethod { cash card gcash maya other }
enum RecipientType { user staff }
enum NotificationType { low_stock shift_unclosed expiring_soon }
enum ActorType { owner terminal platform_admin }
enum AuthTokenKind { invite reset }
```

Models (field lists — write them out in full with the base columns above):

- `Owner` (`owners`): `name`, `email @unique`, `status OwnerStatus @default(active)`, `maxBusinesses Int @default(1)`, `suspendedAt DateTime?` *(addition: needed for the 24-hour default-suspend grace, project-spec §8)*.
- `User` (`users`): `email @unique`, `passwordHash String?` *(null until invite-accept — §8 creates the account first; login treats a null hash exactly like a wrong password, same lockout counting, so pre-activation accounts are not enumerable)*, `role UserRole`, `ownerId String? @db.Uuid`, `pinHash String?`, `totpSecret String?`, `totpRecoveryCodes String[]` (argon2 hashes), `failedLoginCount Int @default(0)`, `loginLockedUntil DateTime?`, `failedPinCount Int @default(0)`, `pinLockedUntil DateTime?` *(lockout columns are the "throttled with lockout" mechanism, project-spec §3)*.
- `AuthToken` (`auth_tokens`): `kind AuthTokenKind`, `tokenHash @unique`, `userId`, `expiresAt`, `usedAt DateTime?`.
- `RefreshToken` (`refresh_tokens`): `tokenHash @unique`, `userId`, `expiresAt`, `revokedAt DateTime?`.
- `Business` (`businesses`): `ownerId`, `name`, `type BusinessType`, `currency String @default("PHP")`, `taxRate Decimal @db.Decimal(5, 4)`, `serviceChargeRate Decimal @db.Decimal(5, 4) @default(0)`, `allowMiscItems Boolean @default(true)`, `isDemo Boolean @default(false)`, `dayStartTime String @default("00:00")`, `expiryWarningDays Int @default(7)`, `logoPath String?`, `receiptHeader String @default("")`, `receiptFooter String @default("")`.
- `Branch` (`branches`): `businessId`, `name`, `code`, `address`; `@@unique([businessId, code])`.
- `Terminal` (`terminals`): `branchId`, `name`, `code`, `deviceTokenHash String?`, `receiptSeq Int @default(1)`, `lastSeenAt DateTime?`; `@@unique([branchId, code])`.
- `Category` (`categories`): `businessId`, `name`, `sortOrder Int @default(0)`.
- `Product` (`products`): `businessId`, `categoryId`, `name`, `sku String?`, `barcode String?`, `price Int`, `cost Int?`, `soldBy SoldBy @default(unit)`, `lowStockThreshold Decimal? @db.Decimal(10, 3)`, `imagePath String?`, `trackStock Boolean @default(true)`, `trackExpiry Boolean @default(false)`, `active Boolean @default(true)`. **No Prisma-level `@@unique` on sku/barcode** — full uniques would let soft-deleted products permanently burn their SKU/barcode; per-business uniqueness lives in Step 3's raw partial indexes (`WHERE deleted_at IS NULL`), and cross-table product-vs-variant uniqueness is a service-level check (Task 12).
- `ProductVariant` (`product_variants`): `productId`, `name`, `sku String?`, `barcode String?`, `price Int`, `cost Int?`; `@@unique([productId, sku])`, `@@unique([productId, barcode])` (DB backstop — the business-wide check is Task 12's service rule).
- `ModifierGroup` (`modifier_groups`): `businessId`, `name`, `minSelect Int @default(0)`, `maxSelect Int @default(1)`.
- `Modifier` (`modifiers`): `groupId`, `name`, `priceDelta Int @default(0)`.
- `ProductModifierGroup` (`product_modifier_groups`): `productId`, `groupId`; `@@unique([productId, groupId])`.
- `Discount` (`discounts`): `businessId`, `name`, `kind DiscountKind`, `value Int` (whole percent, or centavos when fixed), `appliesTo DiscountAppliesTo`, `active Boolean @default(true)`.
- `BranchStock` (`branch_stock`): `branchId`, `productId`, `variantId String? @db.Uuid`, `qty Decimal @db.Decimal(10, 3) @default(0)`.
- `StockMovement` (`stock_movements`): `branchId`, `productId`, `variantId?`, `type MovementType`, `refId String @db.Uuid`, `transferId String? @db.Uuid`, `qtyDelta Decimal @db.Decimal(10, 3)`, `reasonCategory ReasonCategory?`, `unitCost Int?`, `note String?`.
- `Shift` (`shifts`): `branchId`, `terminalId`, `openedAt`, `closedAt DateTime?`, `openingCash Int`, `closingCash Int?`, `expectedCash Int?`.
- `ShiftCashMovement` (`shift_cash_movements`): `shiftId`, `type CashMovementType`, `amount Int`, `reason`.
- `StockCount` (`stock_counts`), `StockCountItem` (`stock_count_items`), `StockBatch` (`stock_batches`): exactly per project-spec §6 (schema only; endpoints are milestone 3).
- `Sale` (`sales`): `branchId`, `terminalId`, `shiftId String? @db.Uuid`, `receiptNo`, `orderType OrderType`, `status SaleStatus`, `statusReason String?`, `subtotal Int`, `discount Int @default(0)`, `discountId String? @db.Uuid`, `serviceCharge Int @default(0)`, `scPwd Json?`, `scPwdDiscount Int @default(0)`, `vatExemptSales Int @default(0)`, `tax Int`, `total Int`, `createdAtDevice DateTime`, `syncedAt DateTime?`, `voidedAt DateTime?`, `refundedAt DateTime?`, `refundShiftId String? @db.Uuid` *(additions the FE contract exposes — out-of-shift refund reporting, pos-spec §7)*, `draft Json` *(addition: the server-validated `SaleDraft` snapshot — `CompletedSale` responses (idempotent replay, `getSale`, void/refund returns) are assembled from `draft` + the status columns, because the FE contract's `CompletedSale extends SaleDraft` carries `DiscountSpec` objects, `scPwdMarked`, and `totals.lines` that the relational columns deliberately reduce to §6 reporting aggregates)*; `@@unique([terminalId, receiptNo])`.
- `SaleItem` (`sale_items`): `saleId`, `productId String? @db.Uuid`, `variantId?`, `nameSnapshot`, `qty Decimal @db.Decimal(10, 3)`, `unitPrice Int`, `costSnapshot Int?`, `discount Int @default(0)` (the APPLIED line-discount amount, promo or SC/PWD), `discountId String? @db.Uuid` (set only for named promos — full line reconstruction always comes from `sales.draft`, never from heuristics on these reporting columns), `modifiers Json`.
- `SalePayment` (`sale_payments`): `saleId`, `method PaymentMethod`, `reference String?`, `amount Int`, `tendered Int`, `change Int`.
- `Notification` (`notifications`): per §6 (schema only).
- `AuditLog` (`audit_logs`): `actorType ActorType`, `actorId String? @db.Uuid`, `ownerId String? @db.Uuid` *(addition: owner-level scope so auth events with no businessId — portal logins, failed logins — still surface in the BO's activity log per §11)*, `businessId String? @db.Uuid`, `branchId String? @db.Uuid`, `action String`, `entityType String`, `entityId String? @db.Uuid`, `changes Json`, `metadata Json` (ip, userAgent, terminalCode, requestId, sessionId, deviceTimestamp?).

Add relation fields as needed for the include-paths used later (Business→branches, Product→variants, Sale→items/payments, etc.).

- [ ] **Step 3: Migrate + raw SQL** — `npx prisma migrate dev --name init`, then append a second migration `constraints` (`npx prisma migrate dev --create-only --name constraints`, edit the SQL, `migrate dev`):

```sql
-- stock can never go negative (project-spec §6)
ALTER TABLE branch_stock ADD CONSTRAINT branch_stock_qty_nonnegative CHECK (qty >= 0);

-- one stock row per (branch, product[, variant]) — NULL variant_id needs partial uniques
CREATE UNIQUE INDEX branch_stock_product_uq ON branch_stock (branch_id, product_id) WHERE variant_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX branch_stock_variant_uq ON branch_stock (branch_id, product_id, variant_id) WHERE variant_id IS NOT NULL AND deleted_at IS NULL;

-- SKU/barcode unique per business among LIVE products only (soft-deleted rows release theirs)
CREATE UNIQUE INDEX products_business_sku_uq ON products (business_id, sku) WHERE deleted_at IS NULL AND sku IS NOT NULL;
CREATE UNIQUE INDEX products_business_barcode_uq ON products (business_id, barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL;

-- audit_logs is immutable to EVERYONE (project-spec §11) — belt and suspenders under the app-layer block
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
```

- [ ] **Step 4: PrismaService** — standard `onModuleInit` connect, global `PrismaModule`. e2e test: insert an `audit_logs` row DIRECTLY via the raw client (all actor/business/entity ids are nullable — a minimal row with actorType/action/entityType/changes/metadata suffices), then attempt UPDATE and DELETE on that row and assert both reject with the trigger message `audit_logs is append-only` (assert the message — a zero-row UPDATE would otherwise pass vacuously); separately insert branch_stock qty −1 → expect the CHECK violation; delete a product then recreate one with the same SKU → succeeds (partial unique releases it).

- [ ] **Step 5: Verify + commit & push** — `git commit -m "feat(api): complete prisma schema per spec §6 with integrity constraints"`

---

### Task 3: Request context (AsyncLocalStorage) + middleware

**Files:**
- Create: `src/common/context/request-context.ts`, `src/common/context/context.middleware.ts`
- Test: `src/common/context/request-context.spec.ts`

**Interfaces:**
- Produces:

```ts
export type Scope = "platform" | "tenant";
export interface RequestContext {
  requestId: string;
  scope: Scope | null;             // null until a guard authenticates
  actor: { type: "platform_admin" | "owner" | "terminal"; id: string } | null;
  ownerId: string | null;          // tenant scope: the BO who owns everything queried
  businessId: string | null;       // set for terminal requests (and portal routes that carry one)
  branchId: string | null;         // set for terminal requests
  terminalCode: string | null;
  sessionId: string | null;        // §11 "session/token id": refresh-token row id (from the access JWT `sid`
                                   // claim) for portal/admin; first 8 hex chars of device_token_hash for terminals
  ip: string; userAgent: string;
  deviceTimestamp: string | null;  // X-Device-Timestamp header (terminal requests)
}
export const requestContext: AsyncLocalStorage<RequestContext>;
export function getContext(): RequestContext;         // throws outside a request
export function setAuthContext(patch: Partial<RequestContext>): void; // called by guards after authentication
```

Middleware (applied to all routes in `AppModule.configure`): seeds the store per request with `requestId = randomUUID()`, ip, user-agent, `X-Device-Timestamp`; sets `X-Request-Id` response header. Guards later call `setAuthContext` to fill scope/actor.

- [ ] **Step 1: Failing unit test** — `requestContext.run` isolation: two concurrent async chains see their own contexts; `getContext()` outside a run throws; `setAuthContext` mutates only the current store.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): per-request AsyncLocalStorage context with request ids"`

---

### Task 4: The choke point — tenancy + audit Prisma extension (TDD-heavy)

**Files:**
- Create: `src/prisma/model-scope-map.ts`, `src/prisma/scoped-prisma.ts`, `src/prisma/scoped-prisma.provider.ts` (`SCOPED_PRISMA` injection token)
- Test: `test/tenancy.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (raw), `getContext()`.
- Produces: `ScopedPrisma` — `prisma.$extends(...)` result, the ONLY client business modules may inject. Rules:

```ts
// model-scope-map.ts
export const PLATFORM_MODELS = ["owner", "user", "authToken", "refreshToken"] as const;
export const TENANT_DIRECT: Record<string, "ownerId" | "businessId" | "branchId"> = {
  business: "ownerId",
  branch: "businessId", category: "businessId", product: "businessId",
  modifierGroup: "businessId", discount: "businessId", notification: "businessId",
  auditLog: "businessId",
  terminal: "branchId", branchStock: "branchId", stockMovement: "branchId",
  shift: "branchId", sale: "branchId", stockCount: "branchId", stockBatch: "branchId",
};
// Everything else (productVariant, modifier, productModifierGroup, saleItem, salePayment,
// shiftCashMovement, stockCountItem) is CHILD-ONLY: no top-level access in tenant scope —
// reach them through relation queries/nested writes of their scoped parent.
export const CHILD_ONLY_MODELS = [...];
```

Extension behavior (`$allModels.$allOperations`):
1. **No context / no scope** → throw (`Error("query outside an authenticated request context")`) — system paths (auth lookups, lockout counters, seeds) use the raw `PrismaService` deliberately.
2. **Tenant scope — reads and targeted writes:** platform models → throw. Direct models → inject the scope filter into `where`: owner context resolves `ownerId` → the allowed `businessId` set (cached per request) for businessId-scoped models, and for **branchId-scoped models** (`terminal`, `branchStock`, `stockMovement`, `shift`, `sale`, `stockCount`, `stockBatch`) the owner's allowed **branch-id set** (second cached lookup) — `branchId` is pinned directly only for terminal actors, who can never touch another branch's rows. Child-only models → throw with a message naming the parent to query through. Soft-delete filter `deleted_at: null` injected into every read — **including nested `include`/`select` of soft-deletable child relations, by walking the args** (Prisma does not intercept relation loads as separate ops) — unless the caller passes `includeDeleted: true` via extension arg. **Special rule for `auditLog` tenant reads:** filter is `businessId ∈ allowed OR (businessId IS NULL AND ownerId = ctx.ownerId)` AND **always excludes `actorType = platform_admin` rows** — BOs are never shown platform access (§4), regardless of what any endpoint passes.
3. **Tenant scope — creates:** for `create`/`createMany`/`upsert` (including upsert's create branch) on scoped models, the extension validates or force-overwrites the scope columns in `data` against the context — owner context: `businessId` must be in the allowed set (branchId-scoped models: `branchId` in the allowed branch set); terminal context: `branchId` pinned to ctx.branchId; nested `connect`/foreign ids resolving outside the allowed sets → throw. Owner A can never create rows inside owner B's tenant by supplying B's ids.
4. **Platform scope:** reads allowed on everything (the §4 read-only visibility). Writes to any tenant model → throw `PlatformWriteError` — with one carve-out: `auditLog.create` is permitted (Task 10's platform-read rows; they are written via the raw-client audit service with `businessId = null`).
5. **Audit write-through:** every successful mutation (create/update/delete/upsert/createMany/updateMany/deleteMany) inserts `audit_logs` row(s) **on the same client/transaction the mutation ran on** — never a separate connection, so audit commits and rolls back atomically with the write. Mechanism: standalone mutations are wrapped so op + audit insert commit together; services that open their own `$transaction` (Tasks 19/20) register the active tx client in the request context (Task 3's store) and the extension's audit insert uses it; the raw client is reserved for platform-scope and auth-path audit writes where no tenant transaction exists. Row content: `action` = `"{model}.{operation}"`, `entityType`/`entityId`, `changes` = `{ after }` for creates, `{ before, after }` for updates (pre-read the matching rows), `{ before }` for deletes/soft-deletes. **Nested writes:** the extension walks the write args — child-model mutations (e.g. a variant price change nested in a product update) are captured with their own before/after in `changes`, and nested `delete`/`deleteMany` on tenant child models are rewritten to soft deletes (or throw) so rule 6 cannot be bypassed. `createMany` on tenant models is rewritten to `createManyAndReturn` (Prisma 6/PG) and logs one row per record. **Scope stamping:** `businessId`/`branchId` on the audit row derive from the mutated entity (scope map + the pre-read; branch→business resolved via a per-request cache), with context values as fallback for terminal requests; `ownerId` always stamped from context — portal mutations must NEVER land with a null businessId. Actor/ip/userAgent/terminalCode/requestId/sessionId/deviceTimestamp come from context. `auditLog` model itself: create allowed, update/delete throw.
6. **Deletes are soft** — `delete`/`deleteMany` on tenant models (top-level AND nested, per rule 5) rewrite to `update` setting `deleted_at` (audit logs the full prior state). Hard deletes exist only for platform models and the account-closure flow (later phase).

- [ ] **Step 1: Failing e2e tests** (each seeds via the raw client, then runs inside `requestContext.run` with a hand-built context):
  - tenant scope owner A listing `business.findMany()` sees only A's businesses (B's exist);
  - tenant write from owner A to owner B's product (id-targeted update) affects 0 rows / throws;
  - terminal context reads `sale.findMany()` filtered to its branch only;
  - platform scope reads everything but `product.update` throws `PlatformWriteError`;
  - `product.update` in tenant scope writes an `audit_logs` row with before/after of the changed fields and the request id;
  - `product.delete` soft-deletes (row has `deleted_at`, subsequent reads exclude it) and audits the prior state;
  - `auditLog.update` throws at the app layer (and the DB trigger backs it);
  - `modifier.findMany()` in tenant scope throws (child-only);
  - **creates policed:** owner A `product.create` carrying owner B's businessId throws; `branchStock.upsert` targeting B's branch throws with no row written;
  - **owner context on branch-scoped models:** owner A `branchStock.findMany()` returns only rows under A's branches; an id-targeted update against B's row affects nothing;
  - **nested writes:** a `product.update` with a nested variant price change produces an audit row containing the variant's before/after; a nested variant delete lands as a soft delete;
  - a tenant-model `createMany` logs one audit row per created record;
  - **entity-derived stamping:** an id-targeted product update in owner context (no businessId in context) produces an audit row whose `businessId` equals the product's business;
  - **BO audit visibility:** a tenant-scope `auditLog.findMany` excludes a seeded `platform_admin` row and includes a `businessId`-null auth row whose `ownerId` matches.
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement** the extension exactly per the rules; keep it in one file with the scope map imported — this is the §11 "one choke point".
- [ ] **Step 4: Green — run the full e2e suite.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): tenancy-enforcing prisma extension with audit write-through and soft deletes"`

---

### Task 5: Totals engine port (money core, TDD)

**Files:**
- Create: `src/common/totals/money.ts`, `src/common/totals/qty.ts`, `src/common/totals/totals.ts`
- Test: `src/common/totals/totals.spec.ts`

**Interfaces:**
- Produces: byte-for-byte the FE plan's Task 2/Task 4 pure modules (`halfUp`, `pct`, `mulRate`, `vatIncluded`, `mulQtyPriceC`, `qtyToMilli`; `DiscountSpec`, `CartLine`, `Cart`, `LineTotals`, `CartTotals`, `computeTotals(cart, { taxRate, serviceChargeRate })`) — the server recomputes every draft with the identical algorithm. Copy the FE plan's algorithm text and test fixtures verbatim (design cart: line grosses `[17000, 7200, 11000, 7125]`, subtotal 42325, promo 1100, SC 2061, total 43286, VAT 4638, VATable 38648; SC/PWD espresso: pay 6071, discount 2429, VAT-exempt 6071; higher-of: scpwd 2857 beats promo 25%/2500, loses to promo 30%/3000; caps; order-percent base excludes scpwd lines).

- [ ] **Step 1: Write the failing tests** (all fixtures above, as in the FE plan Task 4 Step 1 — same numbers, same field names).
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): centavo-exact totals engine (VAT, SC/PWD, service charge) with shared fixtures"`

---

### Task 6: Hashing + lockout service (TDD)

**Files:**
- Create: `src/common/lockout/lockout.service.ts`, `src/auth/hashing.ts`
- Test: `src/common/lockout/lockout.service.spec.ts`

**Interfaces:**
- Produces:
  - `hashing.ts`: `hashSecret(plain: string): Promise<string>` / `verifySecret(hash, plain): Promise<boolean>` (argon2id; `npm i argon2`).
  - `LockoutService` (runs on the **raw `PrismaService`** — `users` is a platform model and these paths run pre-scope or from tenant modules that must never query `users` themselves): `assertNotLocked(user, kind)` → throws `PinLockedError`/`LoginLockedError` with `retryAfterSeconds` when `*_locked_until` is in the future; `recordFailure(userId, kind)` → increments the counter and sets `locked_until = now + 300s` on EVERY failure where the new count ≥ 4 (re-locks after expiry — no unlimited post-lock attempts), with `attemptsRemaining = max(0, 4 − count)` (3→2→1→0, never negative); attempts 1–4 raise `pin_invalid`/`login_invalid`, later ones short-circuit at `assertNotLocked`. The observable pre-expiry sequence matches the FE mock exactly. `recordSuccess(userId, kind)` → resets counter + lock. Convenience wrapper for tenant modules: `verifyPinWithLockout(ownerId, pin): Promise<void>` (fetches the owner user, lock check → verify → counters) so Task 20 never touches `users` directly; no PIN set → `ValidationFailedError("set the refund PIN in the portal")`. Every PIN failure also writes an audit row with the attempted identity (project-spec §11 "failures").

- [ ] **Step 1: Failing unit tests** — the 4-then-lock sequence with `attemptsRemaining` 3,2,1,0; locked short-circuit; **post-expiry re-lock** (advance the clock past 300 s, fail once more → locked again immediately, `attemptsRemaining` still 0); success reset; audit row on PIN failure (assert via raw client).
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): argon2 hashing and 4-strike lockout service with audited failures"`

---

### Task 7: Auth core — login, refresh rotation, guards

**Files:**
- Create: `src/auth/auth.module.ts`, `auth.controller.ts`, `auth.service.ts`, `jwt.strategies.ts`, `guards/portal-auth.guard.ts`, `guards/admin.guard.ts`, `src/common/errors/api-errors.ts`
- Test: `test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: raw `PrismaService` (auth pre-dates scope), `LockoutService`, `hashing`, `setAuthContext`.
- Produces:
  - `api-errors.ts`: `ApiHttpException(status, code, message, extra?)` + subclasses used everywhere — `UnauthorizedError` (401 `unauthorized`), `ForbiddenError` (403 `forbidden`), `ValidationFailedError` (422 `validation`), `StockConflictHttpError` (409 `stock_conflict`, `{ conflicts }`), `PinInvalidHttpError` (403 `pin_invalid`, `{ attemptsRemaining }`), `PinLockedHttpError` (423 `pin_locked`, `{ retryAfterSeconds }`), `LoginInvalidError` (401 `login_invalid`, `{ attemptsRemaining }`), `LoginLockedError` (423 `login_locked`). Global exception filter renders `{ code, message, ...extra, requestId }`.
  - Endpoints: `POST /v1/auth/login {email, password}` → owner: `{ accessToken, refreshToken, role: "owner" }`; platform admin: `{ totpRequired: true, preAuthToken }` or `{ totpSetupRequired: true, preAuthToken }` when not yet enrolled — the preAuthToken is a 5-min JWT carrying `kind: "preauth"`; the access-token strategy and EVERY guard reject tokens with that claim, and only Task 8's TOTP endpoints accept it, so a password alone can never reach `/admin/*`. `POST /v1/auth/refresh {refreshToken}` → rotated pair (old token row revoked, new 30-day row — rolling refresh per §3; reuse of a revoked token revokes the whole user's tokens). `POST /v1/auth/logout {refreshToken}`.
  - Access JWT (15 min): `{ sub: userId, role, ownerId?, sid }` — `sid` is the refresh-token row id minted alongside it (the §11 "session/token id"). `PortalAuthGuard`: verifies JWT (rejects `kind: "preauth"`), loads user + owner, **status checks** — owner `suspended`/`hard_suspended`/`closed` → 403 `owner_suspended` (portal access locks immediately on either tier, §8); calls `setAuthContext({ scope: "tenant", actor: { type: "owner", id }, ownerId, sessionId: sid })`. `AdminGuard`: role must be `platform_admin`; `setAuthContext({ scope: "platform", actor: { type: "platform_admin", id }, sessionId: sid })`. Login lockout via `LockoutService` (`login` kind); a user with `passwordHash` null (pre-activation) fails exactly like a wrong password. Successful and failed logins audit-log (auth events, §11) via an explicit `auditService.logAuth(...)` on the raw client — stamping `ownerId` whenever the attempted identity resolves to an owner user, so the BO's activity log surfaces their own auth events. **Denial auditing:** the global exception filter also writes an audit row (raw client) for 403/423-class denials — `forbidden`, `platform_write_forbidden`, `owner_suspended`, lock-hits, child-only-model violations — using whatever the RequestContext holds at throw time (§11 "permission denials").

- [ ] **Step 1: Failing e2e** — seed an owner user (raw client): login ok → tokens; wrong password ×4 → `login_invalid` countdown then `login_locked`; refresh rotates (old refresh now 401, reuse-detection revokes); suspended owner login → 403 `owner_suspended`; guard rejects garbage/expired tokens; a `passwordHash`-null user's login → `login_invalid` (indistinguishable from wrong password); a platform-write denial produces an audit row.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): jwt auth with rotating 30-day refresh, status checks, lockout"`

---

### Task 8: Platform-admin TOTP (otplib) + recovery codes

**Files:**
- Create: `src/auth/totp.service.ts`, extend `auth.controller.ts`
- Test: `test/totp.e2e-spec.ts`

**Interfaces:**
- Consumes: `preAuthToken` from Task 7; `npm i otplib`.
- Produces: `POST /v1/auth/totp/setup` (accepts ONLY `kind: "preauth"` tokens) → `{ otpauthUri, secret }` (stored pending); `POST /v1/auth/totp/enable {code}` → activates, returns `{ recoveryCodes: string[8] }` ONCE (argon2-hashed at rest); `POST /v1/auth/totp/verify {preAuthToken, code}` → full token pair — accepts a TOTP code (±1 step window) or an unused recovery code (consumed on use). Both TOTP endpoints reject access tokens. Platform-admin login NEVER issues tokens without TOTP (2FA is mandatory for the role, §3). Failed TOTP attempts ride the login lockout counters.

- [ ] **Step 1: Failing e2e** — seeded admin: login → `totpSetupRequired`; setup + enable with a code generated by otplib in the test → recovery codes returned; next login → `totpRequired`; wrong code rejected; correct code → tokens; recovery code works exactly once; **a preAuthToken presented as Bearer on a `/v1/admin/*` route → 401**, and an access token presented to `/totp/setup` or `/totp/verify` → 401.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): mandatory totp 2fa for platform admins with one-time recovery codes"`

---

### Task 9: Mail (Resend) + invites + password reset + demo-business seed

**Files:**
- Create: `src/mail/mail.module.ts`, `mail.service.ts`, `src/auth/invite.service.ts`, `src/portal/demo-seed.ts`, extend `auth.controller.ts`
- Test: `test/invite.e2e-spec.ts`

**Interfaces:**
- Consumes: `npm i resend`; `AuthToken` table.
- Produces:
  - `MailService.send({to, subject, html})` — Resend when `RESEND_API_KEY` set, console-logger transport otherwise (dev/tests read the last message from an exported `sentMailbox` array in the console transport).
  - Invite flow: (created by admin in Task 10) `createInvite(userId)` → single-use `auth_tokens(kind: invite)` (raw 32-byte token in the email link, sha256 hash at rest, 7-day expiry). `POST /v1/auth/invite/accept {token, password}` → sets password, activates the owner, and **seeds the demo business** via `seedDemoBusiness(ownerId)`: an `is_demo` business named exactly **"Kape Diaria (Demo)"** (matching the FE mock's `SEED_BUSINESSES` so Task 22's parity holds) with the same categories/products/variants/modifiers/discounts/stock as the FE mock seed, excluded from `max_businesses` counting (§8). The seed runs on the raw client as system provisioning and writes one summary audit row (`business.demo_seeded`, actor = the owner).
  - Reset flow: `POST /v1/auth/password-reset/request {email}` (always 204 — no user enumeration; sends when the user exists, 1-hour token) → `POST /v1/auth/password-reset/confirm {token, password}` (revokes all refresh tokens).

- [ ] **Step 1: Failing e2e** — invite token accept sets the password and login works; token is single-use and expires; demo business exists with `isDemo`, products present; reset flow round-trips and old refresh tokens die.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): resend mail, invite + reset flows, demo business seeding on activation"`

---

### Task 10: Admin module — owner provisioning, suspend tiers, read-only tenant browse

**Files:**
- Create: `src/admin/admin.module.ts`, `owners.controller.ts`, `owners.service.ts`, `tenant-browse.controller.ts`
- Test: `test/admin.e2e-spec.ts`

**Interfaces:**
- Consumes: `AdminGuard`, `ScopedPrisma` (platform scope), `InviteService`.
- Produces (all under `/v1/admin`, AdminGuard):
  - `POST /owners {name, email, maxBusinesses}` → creates owner + user (no password) + sends invite. `GET /owners`, `GET /owners/:id`, `PATCH /owners/:id {name?, maxBusinesses?}`.
  - `POST /owners/:id/suspend {tier: "default" | "hard"}` → `status = suspended | hard_suspended`, stamps `suspendedAt`; `POST /owners/:id/reinstate` → `active`, clears `suspendedAt`. (Default suspend: portal locked immediately, open shifts may finish selling ≤ 24 h — the terminal-side check lands in Task 16. Hard: everything dies instantly.)
  - Read-only tenant browse (the §4 platform visibility — all through `ScopedPrisma` platform scope, so any accidental write throws): `GET /owners/:id/businesses`, `GET /businesses/:id/branches`, `GET /businesses/:id/activity-log?…filters` (paginated). Every browse hit writes a platform-side admin audit row via the raw-client audit service with **`businessId = null`** (so it can never match a tenant scope filter — rule 2's `actorType` exclusion is the second lock); the browse target is recorded as `entityType`/`entityId` plus `metadata.browsedBusinessId`, keeping the admin log filterable per tenant — platform views are recorded, invisible to BOs (§4/§11).
- [ ] **Step 1: Failing e2e** — admin creates an owner → invite mail in `sentMailbox`; suspend flips status; tenant browse returns owner A data; a platform-context write attempt throws (assert 500→mapped 403 `platform_write_forbidden`); browse writes the admin-log row with `businessId` null — **and after the browse, the BO's own activity-log listing for that business contains no `platform_admin`/`platform_read` row** while the admin-side view shows it.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): admin owner provisioning, two-tier suspension, audited read-only tenant browse"`

---

### Task 11: Portal — businesses + branches

**Files:**
- Create: `src/portal/portal.module.ts`, `businesses/businesses.controller.ts` + service, `branches/branches.controller.ts` + service
- Test: `test/portal-businesses.e2e-spec.ts`

**Interfaces:**
- Consumes: `PortalAuthGuard` (tenant scope), `ScopedPrisma`.
- Produces (all under `/v1/portal`, PortalAuthGuard):
  - `GET/POST /businesses`, `GET/PATCH/DELETE /businesses/:id` — create validates `currency === "PHP"` (§7), `taxRate`/`serviceChargeRate` ∈ [0, 1), `dayStartTime` `HH:mm`; create enforces `maxBusinesses` (demo businesses excluded from the count); delete is the soft archive.
  - `GET/POST /businesses/:businessId/branches`, `GET/PATCH/DELETE /branches/:id` — branch `code` uppercase 2–6 chars, unique per business.
- [ ] **Step 1: Failing e2e** — owner creates business + 2 branches (Marikit MKT / Bayanihan BYN); `maxBusinesses` cap enforced (demo excluded); owner B sees nothing of A's; PHP-only validated; duplicate branch code 422.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): portal businesses and branches with tenant scoping"`

---

### Task 12: Portal — categories, products, variants

**Files:**
- Create: `src/portal/catalog/categories.controller.ts`, `products.controller.ts` + services
- Test: `test/portal-catalog.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `GET/POST /businesses/:businessId/categories`, `PATCH/DELETE /categories/:id` (sortOrder).
  - `GET/POST /businesses/:businessId/products`, `GET/PATCH/DELETE /products/:id` — body mirrors the schema (priceC/costC centavos in DTOs mapped to `price`/`cost`); variants managed as a nested array on the product endpoints (replace-set semantics: create/update/soft-delete to match the submitted list — child-only model, so all through nested writes; removals are nested SOFT deletes). **Uniqueness enforcement:** a service-level check spanning BOTH live products AND live product_variants of the business (no DB constraint can span the two tables) runs on create/update including nested variant writes — violation → 422 `validation` naming the offending field/value; the raw partial indexes (Task 2) are the DB backstop, and their violations surface as PG 23505 without Prisma field metadata — map to the same 422 by constraint name. Products with sales history archive (`active = false`) instead of delete — DELETE returns the archived row (spec §6: never deleted).
- [ ] **Step 1: Failing e2e** — CRUD round-trip incl. variants; duplicate SKU 422; duplicate variant barcode (against another product's barcode AND another product's variant) → 422; delete a no-history product then recreate with the same SKU → 201 (partial unique released it); delete-after-sale archives (seed a sale row via raw client first); cost round-trips for the portal (it is stripped only in POS payloads).
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): portal catalog — categories, products, variants with archive-not-delete"`

---

### Task 13: Portal — modifier groups, product links, discounts

**Files:**
- Create: `src/portal/catalog/modifier-groups.controller.ts`, `src/portal/discounts/discounts.controller.ts` + services
- Test: `test/portal-modifiers-discounts.e2e-spec.ts`

**Interfaces:**
- Produces: `GET/POST /businesses/:businessId/modifier-groups` (+`PATCH/DELETE /modifier-groups/:id`) with nested `modifiers` (replace-set, child-only model, `minSelect ≤ maxSelect`); `PUT /products/:id/modifier-groups {groupIds: string[]}` (replaces the link set); `GET/POST /businesses/:businessId/discounts`, `PATCH/DELETE /discounts/:id` (kind/value/appliesTo per schema; percent 1–100).
- [ ] **Step 1: Failing e2e** — Milk/Add-ons groups round-trip; product link set replace works; `minSelect > maxSelect` 422; Merienda 10% discount created.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): modifier groups, product links, named discounts"`

---

### Task 14: Portal — settings, refund PIN, activity log, terminals

**Files:**
- Create: `src/portal/settings/settings.controller.ts`, `src/portal/activity-log/activity-log.controller.ts`, `src/portal/terminals/terminals.controller.ts` + services
- Test: `test/portal-settings.e2e-spec.ts`

**Interfaces:**
- Produces:
  - Business settings ride `PATCH /businesses/:id` (Task 11) — this task adds `PUT /portal/refund-pin {pin}` (exactly 6 digits → argon2 into `users.pin_hash`). `users` is a platform model, so this write goes through the **raw `PrismaService`** by design (filtered by `ctx.ownerId`) and its audit row (`user.refund_pin_set`, no value logged) is written explicitly via the audit service — the automatic write-through does not cover it.
  - `GET /portal/businesses/:businessId/activity-log?branchId&actorType&action&from&to&page` — paginated reads of `audit_logs` (tenant-scoped; the Task 4 rule already excludes platform rows and admits `businessId`-null rows whose `ownerId` matches, so the BO sees their own auth events but never platform access; the BO-facing `actorType` filter accepts only `owner | terminal`). **Reading the activity log is itself a sensitive read (§11)** — the controller writes an `audit.activity_log_read` row.
  - `GET /portal/businesses/:businessId/terminals` (branch, code, name, pairedAt = createdAt, lastSeenAt, paired = deviceTokenHash != null); `POST /portal/terminals/:id/unpair` → nulls `deviceTokenHash` (the device 401s on its next request — remote unpair, §8).
- [ ] **Step 1: Failing e2e** — PIN set + verify via hashing (and its explicit audit row exists); activity log returns the audit rows earlier tasks generated — including rows from id-targeted portal mutations (product edit, terminal unpair) carrying the right `businessId`, and the owner's own login auth event — filtered by action; the read itself appends a row; unpair nulls the hash.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): refund pin, audited activity-log reads, terminal list + remote unpair"`

---

### Task 15: Portal stock — receive + adjust + levels

**Files:**
- Create: `src/portal/stock/stock.controller.ts`, `src/portal/stock/stock.service.ts` (shared with POS later)
- Test: `test/portal-stock.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `StockService` (the single stock mutator both surfaces use): `receive(branchId, lines: [{productId, variantId?, qty, unitCostC?, expiryDate?}])` — upserts `branch_stock` (+qty), writes `stock_movements(receive)` with `unit_cost`, overwrites product/variant `cost` when `unitCostC` given (latest-cost, §6), creates `stock_batches` rows for `track_expiry` products; `adjust(branchId, {productId, variantId?, newQty, reasonCategory, note?})` — computes `qtyDelta`, rejects `newQty < 0`, updates the level, writes `stock_movements(adjustment)` with reason (audit rides the wrapper); `levels(branchId)` → `StockLevel[]` (tracked products only, per-variant when variants exist). **Variant-integrity rule (both methods, inherited by Task 21's POS adjust):** load the product with its live variants — if it HAS variants, `variantId` is required and must belong to it; if it has none, `variantId` must be null; violations → 422 `validation` (the spec's "stock tracks per-variant only" rule, §6). **`ref_id` semantics:** `receive()` mints one operation uuid per call and stamps it on every movement (+ batch) that call writes, so multi-line receives group; `adjust()` sets `ref_id` to the movement's own id (self-referential — no external referent); sale/void/refund movements use the sale id (Tasks 19–20).
  - Endpoints: `POST /portal/branches/:branchId/stock/receive`, `POST /portal/branches/:branchId/stock/adjustments`, `GET /portal/branches/:branchId/stock`.
- [ ] **Step 1: Failing e2e** — receive creates levels + movements + updates cost; adjust to 2 from 0 works and records reason; negative target 422; receiving a variant product without `variantId` → 422, and with another product's `variantId` → 422; owner A hitting owner B's `branchId` URL → 404/empty with no rows written; qty>=0 DB check holds under a direct decrement race (two parallel adjustments).
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): stock receive/adjust/levels as movement events with latest-cost updates"`

---

### Task 16: POS pairing + TerminalGuard

**Files:**
- Create: `src/pos/pos.module.ts`, `pairing/pairing.controller.ts` + service, `guards/terminal.guard.ts`
- Test: `test/pos-pairing.e2e-spec.ts`

**Interfaces:**
- Consumes: auth (owner credential check + lockout), raw prisma for token lookups, `setAuthContext`.
- Produces (mirrors FE `PosApi` pairing methods exactly):
  - `POST /v1/pos/pairing/sign-in {email, password}` → `{ token, email, ownerName }` — field-for-field the FE's `OwnerSession` (the value is a 10-min pairing-scoped JWT, aud `pairing`; owner role only; suspended owners rejected). Sign-in success/failure is audit-logged as an auth event (§11 "pairing"), ownerId stamped.
  - `GET /v1/pos/pairing/businesses` (pairing token) → `[{ id, name, type, isDemo }]`.
  - `GET /v1/pos/pairing/businesses/:id/branches` → `BranchInfo[]`.
  - `POST /v1/pos/pairing/pair {businessId, branchId, terminalName}` → creates the terminal — `code = "T" + n` where `n` = count of terminals EVER created for the branch **including soft-deleted** (codes are never reused, matching the FE plan); generates a 32-byte device token (raw in the response, sha256 hash in `device_token_hash`); response `{ deviceToken, business: BusinessSettingsDto, branch, terminalName, terminalCode, receiptSeq }` (`receiptSeq` from the terminal row, 1 for new). Pairing writes a `terminal.pair` audit row (full created terminal state, actor = the owner, business/branch/terminalCode in metadata) via the raw-client audit service — §11 names terminal pairing explicitly.
  - `POST /v1/pos/unpair {email, password}` (device token + owner re-auth) → nulls the hash; writes a `terminal.unpair` audit row.
  - `TerminalGuard` (every other `/pos/*` route): `Authorization: Bearer <deviceToken>` → sha256 lookup; miss → 401 `unauthorized` (this is what remote unpair produces). Owner status checks: `hard_suspended`/`closed` → 401; `suspended` → allowed ONLY while an open shift exists for this terminal AND `suspendedAt` < 24 h ago, else 403 `owner_suspended` (§8 default-suspend grace); updates `lastSeenAt` (at most once per 60 s, on the raw client — a liveness timestamp, deliberately exempt from audit); `setAuthContext({ scope: "tenant", actor: { type: "terminal", id }, ownerId, businessId, branchId, terminalCode, sessionId: deviceTokenHash.slice(0, 8) })`.
- [ ] **Step 1: Failing e2e** — full pairing flow returns T1 + token; the pair produced `terminal.pair` (and sign-in auth) audit rows; catalog route 401s after portal unpair; re-pair after unpair yields T2 with `receiptSeq: 1`; POS unpair writes its audit row; hard-suspended owner's terminal 401s; default-suspended terminal with an open shift still sells, without one 403s (and the denial is audited), and past 24 h 403s (manipulate `suspendedAt` via raw client).
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): terminal pairing with branch-scoped device tokens and suspension-aware guard"`

---

### Task 17: POS catalog pull

**Files:**
- Create: `src/pos/catalog/pos-catalog.controller.ts` + service
- Test: `test/pos-catalog.e2e-spec.ts`

**Interfaces:**
- Produces: `GET /v1/pos/catalog` (TerminalGuard) → `CatalogPayload` exactly as the FE defines it: `{ business: BusinessSettings, branch, terminal: {name, code}, categories, products, modifierGroups, discounts (active only), stock, loadedAt }` — products carry `priceC` etc. in DTO naming, include variants + `modifierGroupIds`, and **exclude `cost` entirely** (portal-only, §6); only `active` products; stock = `StockService.levels(branchId)`.
- [ ] **Step 1: Failing e2e** — payload shape matches; `cost` absent from every product/variant JSON (assert stringified payload contains no `"cost"` key); inactive products absent; discounts only active.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): pos catalog payload without costs"`

---

### Task 18: POS shifts — open, cash, totals, close (TDD on the math)

**Files:**
- Create: `src/pos/shifts/shifts.controller.ts` + `shifts.service.ts`
- Test: `test/pos-shifts.e2e-spec.ts`

**Interfaces:**
- Produces (all TerminalGuard, mirroring FE `PosApi`):
  - `GET /v1/pos/shifts/current` → `Shift | null` (`{ id, openedAt, closedAt, openingCashC, cashMovements }`); `POST /v1/pos/shifts {openingCashC}` (422 when one is already open for this terminal); `POST /v1/pos/shifts/current/cash-movements {type: "in"|"out", amountC, reason}`; `GET /v1/pos/shifts/current/totals` → `ShiftTotals`; `POST /v1/pos/shifts/current/close {countedCashC}` → `ZReport`.
  - `ShiftTotals` computation (identical to the FE mock): over this shift's sales — `byMethod`/`grossC`/`saleCount` count **non-voided** sales (refunded-later ones still count as sold; refunds offset separately); `voidCount/voidAmountC` from voided; `refundCount/refundAmountC` from refunds with `refund_shift_id = this shift`; `cashSalesC` = non-voided cash sales; `cashRefundsC` = cash refunds attributed to this shift; `scPwdDiscountC` = Σ `sc_pwd_discount` and `serviceChargeC` = Σ `service_charge` over the same non-voided sale set (both are FE `ShiftTotals` fields and Z-report lines); `expectedCashC = openingCashC + cashSalesC − cashRefundsC + cashInC − cashOutC`. Close stamps `closedAt`, `closingCash`, `expectedCash` and returns the `ZReport` (`ShiftTotals` + shiftId/openedAt/closedAt/openingCashC/countedCashC/overShortC/branchCode/terminalCode).
- [ ] **Step 1: Failing e2e** — reproduce the design's Z arithmetic: opening 200000, cash sales 7200 (a completed sale seeded through Task 19's service or raw rows), cash-in 100000, cash-out 75000 → expected 232200; close with 232000 → overShort −200; double-open 422; totals mid-shift = X reading.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): terminal shifts with X totals and Z-report close"`

(Ordering note: if writing this before Task 19, seed sale rows via the raw client; revisit the e2e to use the real `completeSale` after Task 19 lands.)

---

### Task 19: POS completeSale — the transaction (TDD-heavy)

**Files:**
- Create: `src/pos/sales/sales.controller.ts` + `sales.service.ts`
- Test: `test/pos-sales.e2e-spec.ts`

**Interfaces:**
- Consumes: totals engine (Task 5), `StockService` semantics, TerminalGuard context.
- Produces: `POST /v1/pos/sales` accepting the FE `SaleDraft` verbatim (`{ id, receiptNo, shiftId, orderType, lines: CartLine[], orderDiscount, scPwd, totals: CartTotals, payment: SalePayment (with client `id`), createdAtDevice }`) → `CompletedSale`. Also `GET /v1/pos/sales?date=YYYY-MM-DD` (Manila-day filter on `created_at`, this terminal, newest first) → `SaleSummary[]`, `GET /v1/pos/sales/:id` → `CompletedSale`.

Transaction (single `$transaction`, this order):
1. **Idempotency:** if `sales.id` exists → return the stored `CompletedSale` — assembled from the persisted `sales.draft` snapshot + the status columns, so the replay response is byte-identical to the first — 200 (retried batches never double-post, §5.2). `GET /v1/pos/sales/:id`, and the void/refund responses in Task 20, are assembled the same way; never rebuilt by joining current product/discount rows.
2. Shift check: `draft.shiftId` must be this terminal's open shift → else 422.
3. **Server recompute:** rebuild a `Cart` from the draft lines and run `computeTotals` with the business's `taxRate`/`serviceChargeRate`; any mismatch with `draft.totals` → 422 `validation` ("totals mismatch") — pass `Number(taxRate)` / `Number(serviceChargeRate)` (Prisma Decimals). Snapshot unit prices are accepted as sent (price-lock is the contract; the audit trail records everything). **Line integrity:** every tracked line's product must exist and match the variant rule (product with variants → `variantId` one of its live variants; without → `variantId` null) — violations 422 BEFORE any lock is taken, so a malformed draft can't manufacture phantom stock conflicts. Payment sanity: `amountC === totalC`, cash `tenderedC ≥ totalC`, `changeC = tenderedC − totalC`.
4. **Stock, atomically:** for each tracked line (productId non-null, trackStock, deduped by product+variant with summed qty) `SELECT … FOR UPDATE` the `branch_stock` rows ordered by (product_id, variant_id) — missing row = qty 0; if ANY line lacks stock → roll back, 409 `stock_conflict` with `conflicts: [{ lineId, productId, variantId, availableQty }]` for every failing line (FE shape). Otherwise decrement each row (`qty - Δ`; the DB CHECK backs it).
5. Insert `sales` — **including `draft` = the full server-validated `SaleDraft` JSON** (the CompletedSale source of truth) — with status `completed` and the §6 reporting aggregates from the validated totals: `subtotal`, `discount = promoDiscountC`, `service_charge`, `sc_pwd`, `sc_pwd_discount`, `vat_exempt_sales`, `tax = vatC`, `total`, `discount_id` when the order discount is named, `created_at_device` from draft, `synced_at = now` (the online phase is its own sync); nested `sale_items` (client line ids; `cost_snapshot` from the CURRENT product/variant cost; `discount` = the applied line amount from `totals.lines`, `discount_id` for named promos; `modifiers` = the line's modifier array as JSON) and `sale_payments` (client id). `receipt_no` from the draft; the `@@unique([terminalId, receiptNo])` violation maps to 422. Bump `terminals.receipt_seq` to `max(receipt_seq, seq(draft.receiptNo) + 1)` where **`seq()` parses the trailing digit run** of the receipt number (so `DEMO-MKT-T1-000318` parses too) — re-pairing then hands back a continuation. Audit rows for all of this ride the Task 4 write-through ON the transaction client (rule 5), so a rollback leaves zero audit rows.
6. Insert one `stock_movements(sale)` row per tracked line (`ref_id = sale.id`, negative `qty_delta`).

- [ ] **Step 1: Failing e2e** — happy path stores sale + items + payment + movements + `draft` and decrements stock; **same draft POSTed twice → one sale, second response deep-equals the first** (served from `draft`); `GET /pos/sales/:id` returns the identical `CompletedSale`; short stock → 409 with every conflicting line and NO partial writes (stock unchanged, no sale row, no audit rows); a forced `receiptNo` collision after the decrement step rolls everything back including audit rows; tampered totals → 422; weight line decrements 0.750 exactly; receipt_seq bumped — and a demo sale with receiptNo `DEMO-MKT-T1-000001` bumps it to 2 (trailing-digit parse).
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): idempotent atomic sale completion with server-side totals validation and stock race handling"`

---

### Task 20: POS void + refund (PIN gate)

**Files:**
- Create: extend `sales.controller.ts`/`sales.service.ts`
- Test: `test/pos-void-refund.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `POST /v1/pos/sales/:id/void {reason}` — ungated; sale must be `completed` AND its `shift_id` = this terminal's currently open shift (else 422 — voids only while the sale's shift is open, pos-spec §7); non-empty reason; transaction: set `voided`/`voidedAt`/`statusReason`, restore stock, write `stock_movements(void)` per tracked line. **Restoration mirrors the sale's own `stock_movements` rows** (`type = sale`, `ref_id = sale.id`) with negated `qty_delta` — never derived from the product's CURRENT `trackStock` flag, which may have changed since the sale.
  - `POST /v1/pos/sales/:id/refund {reason, pin}` — PIN gate FIRST via `LockoutService.verifyPinWithLockout(ctx.ownerId, pin)` (Task 6's raw-client path — the sales service never queries `users` itself; no PIN set → 422 "set the refund PIN in the portal"; failures audited with attempted identity); then: sale `completed`, reason required; transaction: set `refunded`/`refundedAt`/`statusReason`, restore stock (same mirror-the-sale's-movements rule as void) + `stock_movements(refund)`, `refund_shift_id` = this terminal's open shift id **iff** it equals the sale's own `shift_id`, else `null` (out-of-shift, skips shift math). Statuses terminal both ways (voided ↛ refunded, 422).
- [ ] **Step 1: Failing e2e** — void restores stock and flags the sale; void after the shift closed 422; refund with wrong PIN ×4 → `pin_invalid` countdown, 5th → `pin_locked` 423; correct PIN refunds in-shift (`refundShiftId` set, expected cash drops per Task 18 totals); after close, refund is out-of-shift (`refundShiftId` null, next shift's expected cash untouched); refunding a voided sale 422; PIN failures appear in audit_logs with the attempted identity; a refund transaction forced to fail mid-way leaves no audit row claiming the status change.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): ungated in-shift voids and pin-gated refunds with out-of-shift attribution"`

---

### Task 21: POS stock endpoints + OpenAPI + FE-contract alignment

**Files:**
- Create: `src/pos/stock/pos-stock.controller.ts`; swagger setup in `main.ts`; `scripts/emit-openapi.ts`
- Test: `test/pos-stock.e2e-spec.ts`, `test/contract.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `GET /v1/pos/stock` → `StockLevel[]`; `POST /v1/pos/stock/adjustments {productId, variantId?, newQty, reasonCategory, note?}` → the updated `StockLevel` (delegates to `StockService.adjust` — same movement + audit path as the portal).
  - Swagger (`npm i @nestjs/swagger`): document EVERY endpoint with typed response models and **stable `operationId`s named after the FE `PosApi` methods** (`ownerSignIn`, `listBusinesses`, `listBranches`, `pairTerminal`, `unpair`, `health`, `pullCatalog`, `getCurrentShift`, `openShift`, `addCashMovement`, `getShiftTotals`, `closeShift`, `completeSale`, `listSales`, `getSale`, `voidSale`, `refundSale`, `getStockLevels`, `adjustStock`) — the generated client's method names then line up 1:1. UI at `/docs` (non-prod only), `scripts/emit-openapi.ts` writes `openapi.json` (script `npm run openapi:emit`) for the FE's `openapi-typescript` step.
  - **Contract table (verify each row while writing `contract.e2e-spec.ts`):**

| FE `PosApi` method | Endpoint | Error semantics |
|---|---|---|
| ownerSignIn | POST /v1/pos/pairing/sign-in | 401 `login_invalid` / 423 `login_locked` — deliberate strengthening over the mock (which throws code `validation`); the HTTP adapter maps `login_invalid` → the FE sign-in error path and surfaces `login_locked` |
| listBusinesses / listBranches | GET /v1/pos/pairing/businesses[/:id/branches] | 401 on bad pairing token |
| pairTerminal | POST /v1/pos/pairing/pair | codes never reused; returns `receiptSeq` |
| unpair | POST /v1/pos/unpair | 401 on bad re-auth |
| health | GET /v1/health | — |
| pullCatalog | GET /v1/pos/catalog | 401 `unauthorized` after remote unpair |
| getCurrentShift / openShift | GET·POST /v1/pos/shifts[/current] | 422 double-open |
| addCashMovement / getShiftTotals / closeShift | /v1/pos/shifts/current/… | 422 no open shift |
| completeSale | POST /v1/pos/sales | idempotent by id; 409 `stock_conflict {conflicts}`; 422 totals |
| listSales / getSale | GET /v1/pos/sales[?date] · /:id | Manila-day filter |
| voidSale / refundSale | POST /v1/pos/sales/:id/void · /refund | 403 `pin_invalid {attemptsRemaining}` · 423 `pin_locked {retryAfterSeconds}` |
| getStockLevels / adjustStock | GET·POST /v1/pos/stock[/adjustments] | 422 negative |

- [ ] **Step 1: Failing e2e** — stock endpoints round-trip; `contract.e2e-spec.ts` walks the table asserting status codes + `code` strings + key response fields for each row (reusing earlier helpers), **including Decimal-as-number assertions**: `expect(body.business.taxRate).toBe(0.12)` (pullCatalog/pairTerminal), `expect(stockRow.qty).toBe(23.45)` (getStockLevels), and a sale item `qty` on getSale — these fail on string serialization; `openapi.json` emits and contains all 19 operationIds.
- [ ] **Step 2–4: Red → implement → green.**
- [ ] **Step 5: Commit & push** — `git commit -m "feat(api): pos stock endpoints, swagger with stable operation ids, contract suite"`

---

### Task 22: Dev seed (FE-mock parity) + verification sweep + README

**Files:**
- Create: `prisma/seed.ts`, `README.md`
- Modify: whatever the sweep flags

- [ ] **Step 1: Seed script** (`npm run db:seed`, guarded to refuse when `NODE_ENV=production`): platform admin `admin@sentry.local` (password printed once; TOTP enrolls on first login) + the dev tenant matching the FE mock byte-for-byte so a real terminal can swap adapters without data surprises: owner Maria Reyes `maria@kapediaria.ph` / `sentry-demo`, refund PIN `123456`, business Kape Diaria (mixed, VAT 0.12, SC 0.05, dayStart 04:00), branches Marikit MKT + Bayanihan BYN, the full FE seed catalog (same names/prices/SKUs/barcodes/modifiers/discounts) and stock (Pan de sal 8, Ube loaf 0, rice 23.450, …), plus the demo business.
- [ ] **Step 2: Full verification** — `npm run lint`, `npm run build`, `npm test`, `npm run test:e2e` all green; manual smoke with the seed: sign in, pair, pull catalog, open shift, complete the design cart sale (total 43286), void, refund with PIN, close shift — via curl/REST client against `npm run start:dev`.
- [ ] **Step 3: README** — run instructions (db:up → migrate → seed → start:dev), env reference, architecture map (context → guard → scoped prisma → audit), the contract table, seed credentials, `openapi:emit` + how the FE consumes it (swap `NEXT_PUBLIC_API_MODE`, generate types with `openapi-typescript`).
- [ ] **Step 4: Commit & push** — `git add -A && git commit -m "docs(api): dev seed with FE parity, verification sweep, README" && git push origin main`

---

## After this plan

- **FE follow-up (separate small task in `sentry-pos-fe`):** implement the HTTP `PosApi` adapter against `openapi.json` — the seam the FE plan reserved (`NEXT_PUBLIC_API_MODE=http` + `NEXT_PUBLIC_API_URL`). The adapter maps the two documented divergences: sign-in 401 `login_invalid` → the FE's wrong-credentials error path (or extend the FE taxonomy with `LoginInvalidError`/`LoginLockedError`), and surfaces `login_locked` on the pairing screen.
- **Milestone 3 (separate plan):** Analytics endpoints + CSV, daily summary emails, notifications, stock-take + transfers + expiry surfacing, terminal management polish.
- **Milestone 4 (separate plan):** `/sync/pull` + `/sync/push` with cursors.
