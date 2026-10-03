# Staff Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give owners, managers, and cashiers secure, attributable terminal access and give managers branch-scoped portal access.

**Architecture:** `User` is the human security principal. A staff profile gives managers/cashiers business membership and branch assignments. A paired device token and a short-lived operator session authorize terminal mutations together. Backend policies enforce the fixed matrix and portal branch scope.

**Tech Stack:** NestJS 11, Prisma 6/PostgreSQL, Next.js 15/React 19, Jest, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-staff-access-design.md`

## Global Constraints

- Preserve all existing uncommitted online-workflow changes in the three child repositories.
- Six-digit PINs; 15-minute, five-attempt temporary challenges; five-minute operator inactivity; 12-hour absolute session lifetime.
- Every protected terminal mutation validates device, human, branch, role, owner status, and relevant shift in the backend.
- No fake owner staff profile, custom permission editor, remote approval, cost visibility for managers, or portal session for cashiers.
- Legacy operational rows remain unattributed rather than being assigned to a guessed person.
- Money remains integer centavos; UTC storage and Asia/Manila display; terminal static export; business branding on receipts.

## Review Focus

1. A cashier whose branch assignment is removed while a cart is open must be unable to submit it; Task 4 and 5 tests.
2. A manager guessing another branch's URL or export must see no data; Task 3 and 8 tests.
3. A manager approval must not change the cashier's shift attribution; Task 5 and 7 tests.
4. A lost payment response followed by lock must replay the same sale ID under the original operator; Task 5 and 7 tests.
5. Deactivation during an open shift must block sales but allow a separately attributed emergency close; Task 5 tests.

---

### Task 1: Human and session schema

**Files:** `sentry-pos-be/prisma/schema.prisma`, a new `sentry-pos-be/prisma/migrations/<timestamp>_staff_access/migration.sql`, `sentry-pos-be/src/staff/staff-policy.ts`, `sentry-pos-be/src/staff/staff-policy.spec.ts`, and scoped model configuration.

**Interfaces:** Produce `StaffProfile`, `StaffBranch`, `StaffChallenge`, `OperatorSession` and nullable human attribution relations. `UserRole` adds `manager|cashier`; `ActorType` adds `staff`. Produce `permissionFor(role, action): 'allow' | 'approval' | 'self_pin' | 'deny'` with the fixed matrix.

- [ ] Write failing policy tests for owner, manager, and cashier actions, including owner free-entry discount and cashier manager-approved actions.
- [ ] Run `npm test -- --runInBand src/staff/staff-policy.spec.ts`; expect missing module failure.
- [ ] Add the role policy and schema/migration. The policy boundary must be explicit:

```ts
export type StaffAction = 'terminal_sell' | 'terminal_free_discount' | 'terminal_void' | 'terminal_refund' | 'terminal_stock_adjust' | 'portal_staff_admin';
export type Permission = 'allow' | 'approval' | 'self_pin' | 'deny';
export function permissionFor(role: UserRole, action: StaffAction): Permission;
```

- [ ] Run Prisma validate/generate and the focused test; expect clean schema and green policy tests.

### Task 2: Owner-managed staff and temporary credentials

**Files:** new `sentry-pos-be/src/staff/` service/controller/DTO/tests, `src/auth/` challenge service/controller, `src/mail/mail.service.ts`, `src/portal/portal.module.ts`, `src/app.module.ts`.

**Interfaces:** Owner-only `GET/POST/PATCH /v1/portal/businesses/:businessId/staff`, `POST /:userId/reset-pin`, `POST /:userId/reset-password`, and `POST /:userId/deactivate`. `POST /v1/auth/staff/setup-manager` accepts email, temporary PIN, password and permanent PIN. Cashier setup is terminal-bound in Task 4. All staff API responses omit hashes and used challenges.

- [ ] Write failing service/API tests for manager email requirement, cashier without email, cross-business branch rejection, one-time PIN display, challenge expiry/attempts, resend invalidation, session revocation, and deactivation history preservation.
- [ ] Run `npm test -- --runInBand src/staff`; expect the new behavior to fail.
- [ ] Implement scoped staff management and cryptographic challenge creation/consumption. The manager setup result is a normal manager token pair only after both credentials are set:

```ts
type ManagerSetup = { email: string; temporaryPin: string; password: string; permanentPin: string };
type SetupResult = { accessToken: string; refreshToken: string; role: 'manager' };
```

- [ ] Run focused tests, backend unit suite, and a migration against an isolated test database; expect no staff access before setup.

### Task 3: Portal role and branch boundary

**Files:** `sentry-pos-be/src/auth/auth.service.ts`, `src/auth/guards/portal-auth.guard.ts`, new `src/staff/portal-scope.ts`, affected `src/portal/**` service/controller/report queries, `sentry-pos-landing/src/middleware.ts`, `src/lib/auth/**`, `src/lib/api/**`, manager scope tests.

**Interfaces:** `PortalAuthGuard` accepts owner or active manager; rejects cashier. `assertPortalAction` and `allowedBranchIds` provide the shared backend policy. Refresh and JWT role are rechecked against database role/status. Manager routes/exports cannot return cost or profit fields.

- [ ] Write failing guard and endpoint tests proving a manager cannot read another branch, owner-only settings, staff management, profit/leaks, or cost-bearing responses; cashier cannot enter portal; owner access remains intact.
- [ ] Run the focused guard/E2E tests; expect forbidden-path failures.
- [ ] Implement database-backed portal role checks and branch-scoped queries/exports. Keep URL/navigation checks as presentation only:

```ts
type PortalPrincipal = { userId: string; ownerId: string; role: 'owner' | 'manager'; businessId?: string; branchIds: string[] };
function assertPortalAction(principal: PortalPrincipal, action: string, branchId?: string): void;
```

- [ ] Run focused tests and backend suite; inspect response bodies for cost/margin fields, not only status codes.

### Task 4: Terminal operator session

**Files:** new `sentry-pos-be/src/pos/operators/` controller/service/guard/tests, `src/common/context/**`, `src/pos/pos.module.ts`, `src/pos/guards/terminal.guard.ts`, `sentry-pos-fe/src/api/client.ts`, `src/api/http/adapter.ts`, `src/api/mock/**`, `src/state/operator.ts`.

**Interfaces:** `GET /v1/pos/operators` gives active branch roster; `POST /v1/pos/operators/unlock` and `/setup-pin` verify name-first PIN, and `POST /lock` revokes. Operator token is sent as `X-Operator-Token` beside the device bearer. Backend enforces 5-minute inactivity and 12-hour maximum. FE keeps token in memory only.

- [ ] Write failing backend tests for owner with/without PIN, cashier setup, wrong PIN attribution, expiry, terminal mismatch, branch removal, deactivation and device revocation; write HTTP/mock adapter tests for the second token.
- [ ] Run focused backend and FE tests; expect unauthorized session cases to fail.
- [ ] Implement operator sessions, device-plus-human guard, typed `PosApi` methods, and mock parity:

```ts
type OperatorIdentity = { userId: string; name: string; role: 'owner' | 'manager' | 'cashier' };
type OperatorUnlock = { operator: OperatorIdentity; token: string; expiresAt: string };
```

- [ ] Run focused tests, backend suite, FE suite, and static type/build checks.

### Task 5: Operational attribution and approvals

**Files:** `sentry-pos-be/src/pos/shifts/**`, `src/pos/sales/**`, `src/pos/stock/**`, `src/portal/stock/**`, `src/common/lockout/**`, tests in those modules and real API E2E.

**Interfaces:** Shift/sale/cash/stock writes carry operator ID. A one-action approver identity/PIN is validated within the mutation. Emergency close accepts counted cash and required reason. Ordinary close requires shift operator. API reads expose operator and closer without hashes.

- [ ] Write failing tests for shift ownership, approval success/failure and both identities, owner/manager direct refund PIN, duplicate-sale replay, deactivation, emergency close, and branch mismatch.
- [ ] Run focused tests; expect missing operator/policy checks to fail.
- [ ] Add transactional checks to existing services, preserve sale ID replay and stock/totals behavior, and record human IDs in records plus audit metadata:

```ts
type ApprovalInput = { approverUserId: string; pin: string };
type EmergencyCloseInput = { countedCashC: number; reason: string };
```

- [ ] Run backend unit/E2E suites and inspect legacy row serialization; expect no guessed operator and no changed money totals.

### Task 6: Owner Staff page and manager portal

**Files:** new `sentry-pos-landing/src/app/(app)/portal/businesses/[businessId]/staff/**`, `src/lib/api/staff.ts`, `src/lib/api/types.ts`, `src/components/app/portal-nav.ts`, business/analytics layouts, login/setup routes, tests.

**Interfaces:** Staff list/form/actions use server-only API client. Cashier temporary PIN appears once after creation/reset. Manager login setup uses email + temporary PIN, then password/PIN setup. Manager navigation only includes permitted sections and branch selector values.

- [ ] Write failing component/action tests for owner list/create/reset/deactivate, one-time PIN reveal, manager setup and manager navigation; test direct URL denial through rendered route/API.
- [ ] Run relevant Vitest files; expect new routes/components to fail.
- [ ] Build the pages with existing Figtree/teal/green tokens, cards, pill controls, alerts and responsive form patterns. Keep credentials out of client-readable portal cookies and logs.
- [ ] Run landing tests, lint and build; inspect phone and desktop layouts in a real browser.

### Task 7: Terminal roster, lock, approvals, activity

**Files:** `sentry-pos-fe/src/components/chrome/TerminalGate.tsx`, new operator lock/roster components and `/unlock` route, shift/history/stock pages, API adapters/types/mock store, operator tests.

**Interfaces:** Lock screen precedes shift/payment redirects. Manual lock and five-minute client idle timer clear the in-memory operator token but preserve cart and shift. Pending draft retains operator ID. Restricted actions use the separate approval form. `My activity` is filtered by server operator identity.

- [ ] Write failing component and adapter tests for fresh pairing, reload, idle/manual lock, shift-owner-only resume, pending sale, cashier first PIN change, approval without takeover, held carts at close, and activity isolation.
- [ ] Run relevant Vitest files; expect old device-only flows to fail.
- [ ] Implement dense operational UI using existing design components and typed API methods. Update mock persistence for staff identities but never persist an active operator token.
- [ ] Run FE suite, lint and static build; use a browser to check tablet, phone, and desktop flows.

### Task 8: Reports, live contracts, and release verification

**Files:** backend cashier analytics/activity services/tests, landing analytics types/views/tests, FE/BE/landing integration tests, Sentry POS skill reference updates where contracts changed.

**Interfaces:** Per-cashier sales, requested void/refund counts, miscellaneous share, and over/short; legacy rows labeled. Manager exports match branch-scoped on-screen data and omit cost/profit. Live flows cover owner, manager, and cashier.

- [ ] Write failing report and cross-repository integration tests for cashier metrics, legacy rows, manager export branch/cost isolation, and owner operation.
- [ ] Run focused tests; expect missing columns/scope to fail.
- [ ] Implement report projections and update UI/API types, then run all three full suites, E2E suites against an isolated database, lint/typecheck/build, browser smoke flows, and `graft build` in changed repositories.
- [ ] Review the complete diff for secret leakage, tenant scope, audit identity, and unchanged online behavior before starting offline sync.
