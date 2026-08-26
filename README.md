# Sentry POS — Backend

A multi-tenant Point-of-Sale API for small Philippine businesses: a **platform
admin** provisions owners, each **owner** manages businesses/branches/catalog/stock
through a portal, and paired **POS terminals** sell, run shifts, and reconcile
cash — offline-first on the device and idempotent on sync.

Built with **NestJS 11 + Prisma (PostgreSQL)**. Money is integer centavos; the
totals engine is byte-for-byte identical to the frontend's.

---

## Quick start

Prerequisites: Node 20+, Docker (for Postgres).

```bash
npm install
npm run db:up                 # Postgres 16 on localhost:54400 (docker compose)
cp .env.example .env          # then edit secrets if you like
npx prisma migrate deploy     # apply migrations
npm run db:seed               # FE-parity dev tenant (prints the admin password once)
npm run start:dev             # API on http://localhost:4000, Swagger UI at /docs
```

All routes are under the `/v1` prefix (e.g. `GET http://localhost:4000/v1/health`).

### Seed credentials

`npm run db:seed` resets the DB and inserts a tenant that mirrors the FE mock
(`frontend/pos/src/api/mock/seed.ts`) byte-for-byte. It **refuses to run when
`NODE_ENV=production`**.

| Role | Email | Secret |
|---|---|---|
| Platform admin | `admin@sentry.local` | random password **printed once** by the seed; TOTP enrolls on first login |
| Owner (POS sign-in) | `maria@kapediaria.ph` | password `sentry-demo`, refund PIN `123456` |

Business **Kape Diaria** (mixed, VAT 12%, service charge 5%, day start 04:00) with
branches **Marikit (MKT)** and **Bayanihan (BYN)**, the full catalog (coffee /
bakery / grocery / meals, modifier groups, named discounts) and the FE stock
levels (Pan de sal 8 → low, Ube loaf 0 → out, Jasmine rice 23.450, …), plus a
separate **Kape Diaria (Demo)** business.

---

## Environment variables

| Var | Purpose |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Postgres connection (compose default: `…@localhost:54400/sentry_pos_dev`) |
| `JWT_ACCESS_SECRET` | Portal/admin access-token signing secret |
| `JWT_REFRESH_SECRET` | Rotating refresh-token secret |
| `JWT_PAIRING_SECRET` | 10-minute pairing-token secret (POS sign-in → pair) |
| `CORS_ORIGINS` | Comma-separated allow-list |
| `RESEND_API_KEY` | Transactional mail; **unset in dev → mail logs to console** |
| `MAIL_FROM` | From header for outbound mail |
| `PORT` | HTTP port (default 4000) |
| `NODE_ENV` | `production` disables `/docs` and blocks `db:seed` |

---

## Architecture

Every request flows through one pipeline, and every tenant DB operation through
one choke point:

```
HTTP request
  → ContextMiddleware        stamps a per-request AsyncLocalStorage RequestContext
  → Guard                    AdminGuard | PortalAuthGuard | PairingGuard | TerminalGuard
                             — resolves the actor and sets the scope on the context
  → Controller / Service     business logic
  → ScopedPrisma  (the choke point, src/prisma/scoped-prisma.ts)
        · filters every read to the caller's owner / business / branch
        · forces FKs on create, rewrites deletes to soft-deletes
        · writes an append-only audit_logs row on the SAME transaction as each mutation
  → ApiExceptionFilter       renders { code, message, requestId }; audits denials
```

- **Tenancy** is enforced centrally: business modules inject `SCOPED_PRISMA`, never
  the raw client. A terminal actor is pinned to its branch; an owner sees only
  their own businesses. Auth/system/seed paths use the raw `PrismaService`
  deliberately.
- **Money**: integer centavos everywhere; `src/common/totals` is the shared engine
  (parity with the FE). Decimal columns serialize as numbers (`.toNumber()`).
- **Auth**: argon2id hashing, 4-strike lockout, rotating refresh tokens, mandatory
  TOTP 2FA for platform admins, PIN-gated refunds.

---

## API surface (FE `PosApi` contract)

The POS endpoints map 1:1 to the frontend's `PosApi`. `test/contract.e2e-spec.ts`
walks this table; `openapi.json` carries a stable `operationId` per row so a
generated client's method names line up exactly.

| FE method | Endpoint | Notes / error semantics |
|---|---|---|
| `ownerSignIn` | `POST /v1/pos/pairing/sign-in` | 401 `login_invalid` / 423 `login_locked` |
| `listBusinesses` / `listBranches` | `GET /v1/pos/pairing/businesses[/:id/branches]` | 401 on bad pairing token |
| `pairTerminal` | `POST /v1/pos/pairing/pair` | codes never reused; returns `receiptSeq` + device token |
| `unpair` | `POST /v1/pos/unpair` | 401 on bad owner re-auth |
| `health` | `GET /v1/health` | — |
| `pullCatalog` | `GET /v1/pos/catalog` | active products only; **cost excluded**; 401 after remote unpair |
| `getCurrentShift` / `openShift` | `GET`·`POST /v1/pos/shifts[/current]` | 422 double-open |
| `addCashMovement` / `getShiftTotals` / `closeShift` | `/v1/pos/shifts/current/…` | 422 when no shift is open |
| `completeSale` | `POST /v1/pos/sales` | idempotent by id; 409 `stock_conflict {conflicts}`; 422 totals mismatch |
| `listSales` / `getSale` | `GET /v1/pos/sales[?date]` · `/:id` | Manila-day filter; assembled from the stored draft |
| `voidSale` / `refundSale` | `POST /v1/pos/sales/:id/void` · `/refund` | refund is PIN-gated: 403 `pin_invalid {attemptsRemaining}` · 423 `pin_locked {retryAfterSeconds}` |
| `getStockLevels` / `adjustStock` | `GET`·`POST /v1/pos/stock[/adjustments]` | 422 on a negative target |

Owner **portal** (`/v1/portal/…`) and **platform admin** (`/v1/admin/…`) surfaces
exist alongside the POS surface; see the Swagger doc for the full list.

---

## OpenAPI / generating the FE client

```bash
npm run db:up            # a DB must be reachable (the emit boots the app, which connects Prisma)
npm run openapi:emit     # writes openapi.json at the repo root (/v1 prefix; the 19 FE PosApi methods carry stable operationIds)
```

Swagger UI is served at **`/docs`** in non-production. The FE consumes `openapi.json`
via `openapi-typescript` and swaps its adapter with `NEXT_PUBLIC_API_MODE=http` +
`NEXT_PUBLIC_API_URL`. Two deliberate divergences from the FE mock the HTTP adapter
maps: sign-in returns 401 `login_invalid` (→ the FE wrong-credentials path) and
surfaces 423 `login_locked`.

---

## Testing

```bash
npm run lint             # eslint + prettier
npm run build            # nest build (tsc)
npm test                 # unit specs (totals engine, guards) — no DB needed
npm run test:e2e         # full e2e (boots the app against the compose DB)
```

The e2e suite brings the DB up via `globalSetup`. On Windows the compose port
`54400` can fall in a reserved range; if it fails to bind, restart `winnat`
(`net stop winnat && net start winnat`) or point `DATABASE_URL` at another Postgres.

---

## Scripts

| Script | Does |
|---|---|
| `db:up` / `db:down` | start / stop the compose Postgres |
| `db:seed` | reset + seed the FE-parity dev tenant (dev only) |
| `openapi:emit` | write `openapi.json` for FE client generation |
| `start:dev` | watch-mode dev server |
| `build` / `start:prod` | production build / run |
