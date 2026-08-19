# Sentry — Project Spec

**Status:** Scoping locked · **Updated:** 2026-08-18

## 1. Overview

**Sentry** — *Your business, always in sight.* A multi-tenant POS / business-monitoring SaaS.

A multi-tenant point-of-sale platform. The platform admin provisions Business Owner (BO) accounts — there is no public signup. Each BO creates one or more businesses; each business has one or more branches; each branch runs the same POS on registered terminals. The POS is **designed offline-first but built online-first**: the online product ships first, and the offline layer (§5) is added as the final phase on conventions laid from day one.

MVP is **owner-operated**: the BO runs the POS directly. Staff accounts (managers, cashiers) arrive in the next phase.

## 2. Hierarchy & Roles

```
Platform Admin → Business Owner → Business → Branch → Terminals
```

| Role | Scope | Capabilities |
|---|---|---|
| Platform Admin | Platform | Create/suspend BO accounts, set per-BO limits, platform operational health, admin-action audit log. **Full read-only visibility into all tenant data and activity logs** — sees everything, edits nothing tenant-side |
| Business Owner | Their businesses | Create businesses/branches, manage catalog & settings, all reports, operate the POS |

Deferred to the staff phase: **Manager** (approval gates, shift oversight) and **Cashier** (PIN-unlocked sale flow).

**Principle — BO sovereignty, total record:** within their own businesses, the BO is never permission-gated. The only mechanisms that ever touch a BO are intent confirmation (their own refund PIN), data invariants with an escape hatch (`qty >= 0` + quick adjust), and the immutable activity log (§11) — which is not a restriction but the counterpart of the freedom: anything can be done, and everything done is recorded. Future features inherit this rule.

Scoping rules:

- Catalog, prices, modifiers, settings → **business** level (shared by all branches)
- Stock, shifts, sales, terminals → **branch** level
- Sales and shifts attribute to the **terminal** in MVP (staff attribution comes with the staff phase)
- Reports roll up: branch → business → all businesses (BO view)

## 3. Tech Stack

- **Language:** TypeScript everywhere — API, both Next.js apps, and shared packages, with `strict: true` across the monorepo. No `.js` source files.
- **API:** NestJS, Prisma, PostgreSQL hosted on **Supabase** — used strictly as managed Postgres. No Supabase Auth or PostgREST; Prisma is the only database client. Migrations use the direct connection (`directUrl`, port 5432).
- **POS terminal:** Next.js with `output: 'export'` (static, client-only), PWA via Serwist, Dexie (IndexedDB)
- **Portals:** Next.js, role-gated routes (platform admin + BO portal)
- **Landing:** one public page at the apex, served by the portal app — fully specified in **`landing-spec.md`** (sections, copy rules, typed content model; content edited via **Payload CMS** at `/cms`, own `cms` schema, ISR revalidation). Ships in milestone 3.
- **Responsive rule:** every surface is fully responsive across mobile, tablet, laptop, and desktop. The POS designs tablet-landscape-first and adapts both ways; the portal designs phone-first for on-the-go owner actions (dashboard, notifications, PIN resets, remote unpair) and expands into full Analytics layouts on larger screens.
- **Design language:** `design-spec.md` — the adopted token system (deep-teal bands, green pill CTAs, 12px cards, pill buttons everywhere; typeface licensing pending). Portal and landing use the full language; the terminal inherits tokens in a dense operational layout.
- **Frontend rule:** all business logic lives in the Nest API; Next.js is presentation only. The POS app must remain fully static — the service worker caches the exported shell, so it runs with zero network. No server rendering, server actions, or route handlers in the `pos` app.
- **Repositories:** two — `sentry-pos-fe` (both Next.js apps as `portal/` and `pos/`) and `sentry-pos-be` (the NestJS API). The four spec documents live at the root of both.
- **API contract:** the API publishes an OpenAPI spec via `@nestjs/swagger`; the frontend generates its typed client with `openapi-typescript`. This replaces the shared-package approach — type safety survives the repo split.
- **Auth:** JWT access + refresh (Passport) for portals; **TOTP 2FA** (`otplib`) with one-time recovery codes for the platform admin role. Login and PIN attempts are throttled with lockout; portal sessions ride a 30-day rolling refresh. Terminal pairing: the BO signs in once on the device, the API issues a branch-scoped device token, and the terminal operates under it from then on. A **6-digit BO PIN** (set in the portal) gates refunds at the terminal; staff PIN unlock ships with the staff phase.
- **Email:** Resend — BO invites, password resets, and a **per-business daily summary email** at each business's day boundary: sales, gross profit, transactions, by-branch breakdown, voids/refunds, over/short. Toggleable per business, on by default; demo businesses send no emails.
- **In-portal notifications:** a bell with an unread badge in the BO portal. MVP types: **low stock** — fires once when a product crosses its `low_stock_threshold` at a branch, re-arms when stock recovers above it, links to the product's stock page — **shift left open** — fires when a branch crosses its day boundary with a shift still open, mirroring the terminal's own nag — and **expiring soon** — fires when a batch enters the business's `expiry_warning_days` window. The `notifications` table is typed, so future alert kinds add without schema work; managers inherit their branches' alerts in the staff phase. Demo businesses generate no notifications.
- **File storage:** Supabase Storage for product photos and business logos, accessed **only by the Nest API** (service key server-side, short-lived signed URLs out; one private bucket, paths keyed by `business_id`). This is the written exception to "Supabase = Postgres only" — still zero `supabase-js` in any frontend.
- **Hosting:** API on Render, apps on Vercel, everything in Singapore regions — details in §12.

## 4. Multi-Tenancy

Single Postgres database. Scoping columns cascade: `owner_id` → `business_id` → `branch_id`. A Nest guard resolves every request into exactly one of two contexts, and a Prisma client wrapper enforces it:

- **Tenant scope** (BO portal, terminals): tenant tables only, every query filtered by the caller's `owner_id`/`business_id`/`branch_id`.
- **Platform scope** (admin): full CRUD on `owners`/`users` and platform tables, plus **read-only access across all tenant data and activity logs**. Any *write* to a tenant table from platform context throws — the platform sees everything and edits nothing.

There is no impersonation feature: the platform reads as itself, never acts as a BO. Platform views of tenant data are recorded in the platform-side admin log (visible to the platform admin only — BOs are not shown platform access). This access model is quiet in-product but **must be disclosed in the privacy policy** (PH Data Privacy Act) — lawyer wording, pre-pilot.

## 5. Offline-First Design

*Built as the final milestone — until then the terminal calls the API directly. The conventions below (client UUIDs, append-only events, soft deletes, static client-only terminal app) apply from the first line of code, so this layer bolts on without a rewrite.*

1. **Down-sync (terminal treats as read-only):** categories, products (minus `cost`), variants, modifiers, named discounts, business/branch settings. All editing happens online in the portal — this eliminates two-way merge conflicts.
2. **Up-sync (append-only):** sales, sale_items, sale_payments, stock_movements, shift events (open/close, cash in/out). All IDs are client-generated UUIDs; the server upserts idempotently, so retried batches can never double-post.
3. **Cursors:** `GET /sync/pull?cursor=` returns changed rows plus a new server-issued cursor. Never trust device clocks. Soft deletes (`deleted_at`) so removals propagate.
4. **Receipt numbers:** `{branchCode}-{terminalCode}-{seq}` — the sequence is owned by the terminal, so numbering survives offline. (Also aligns with BIR per-machine sequential numbering.)
5. **Stock:** terminal decrements its local cache; canonical stock is rebuilt server-side from `stock_movements` events on sync. Eventual consistency accepted — two terminals selling the last unit offline is a known edge case.
6. **Online-only surfaces:** platform admin, BO portal, cross-branch reports, catalog editing.

## 6. Data Model

Every table: `id uuid PK, created_at, updated_at, deleted_at`. Sync-relevant tables cursor on server-assigned change order. **All money columns are integer centavos** (§7); quantity columns are `numeric(10,3)`.

```
owners                   name, email, status(active|suspended|hard_suspended|closed),
                         max_businesses
users                    email, password_hash, role(platform_admin|owner), owner_id?,
                         pin_hash?, totp_secret?, totp_recovery_codes?
businesses               owner_id, name, type(retail|fnb|mixed), currency, tax_rate,
                         service_charge_rate, allow_misc_items, is_demo, day_start_time,
                         expiry_warning_days,
                         logo_path?, receipt_header, receipt_footer
branches                 business_id, name, code, address
terminals                branch_id, name, code, device_token_hash, receipt_seq,
                         last_seen_at
categories               business_id, name, sort_order
products                 business_id, category_id, name, sku, barcode, price, cost?,
                         sold_by(unit|weight), low_stock_threshold?, image_path?,
                         track_stock, track_expiry, active
product_variants         product_id, name, sku, barcode, price, cost?
modifier_groups          business_id, name, min_select, max_select
modifiers                group_id, name, price_delta
product_modifier_groups  product_id, group_id
discounts                business_id, name, kind(percent|fixed), value,
                         applies_to(line|order|both), active
branch_stock             branch_id, product_id, variant_id?, qty  (CHECK qty >= 0)
stock_movements          branch_id, product_id, variant_id?, type(sale|void|refund|
                         adjustment|receive|transfer_out|transfer_in), ref_id,
                         transfer_id?, qty_delta,
                         reason_category(damage|expiry|theft_loss|count_correction|other)?,
                         unit_cost?, note?
shifts                   branch_id, terminal_id, opened_at, closed_at,
                         opening_cash, closing_cash, expected_cash
shift_cash_movements     shift_id, type(in|out), amount, reason
stock_counts             branch_id, status(draft|posted), counted_at, notes?
stock_count_items        count_id, product_id, variant_id?, counted_qty,
                         system_qty_at_post, variance
stock_batches            branch_id, product_id, variant_id?, received_qty,
                         expiry_date, receive_movement_id
sales                    branch_id, terminal_id, shift_id?, receipt_no,
                         order_type(dine_in|takeout|none),
                         status(completed|voided|refunded), status_reason?,
                         subtotal, discount, discount_id?, service_charge, sc_pwd(jsonb: id_no, name)?,
                         sc_pwd_discount, vat_exempt_sales, tax, total,
                         created_at_device, synced_at
sale_items               sale_id, product_id?, variant_id?, name_snapshot, qty,
                         unit_price, cost_snapshot?, discount, discount_id?, modifiers(jsonb)
sale_payments            sale_id, method(cash|card|gcash|maya|other), reference?,
                         amount, tendered, change
notifications            recipient_type(user|staff), recipient_id, type(low_stock|shift_unclosed|expiring_soon),
                         title, body, business_id?,
                         branch_id?, entity_id?, read_at?
audit_logs               actor_type(owner|terminal|platform_admin), actor_id,
                         business_id?, branch_id?, action, entity_type, entity_id?,
                         changes(jsonb before/after), metadata(jsonb: ip, terminal code)
```

Notes: `sale_items` snapshots name and price at sale time; `product_id` is nullable for open-price misc lines. `sales.shift_id` is nullable for out-of-shift refunds. SKU and barcode are unique per business. If a product has variants, stock tracks per-variant only; otherwise at product level. Receiving may set a new unit cost: the product's `cost` is overwritten (latest-cost method) and the receive movement stores `unit_cost`, so weighted average stays derivable later. Batches exist only at receive time for `track_expiry` products; remaining batch quantities are FEFO-derived — the sale flow never touches batches. Products with sales history are archived (`active = false`), never deleted. Card/GCash/Maya are recorded payment *types* only in MVP. Staff tables and `staff_id` attribution arrive with the staff phase — nullable columns via a trivial migration. `audit_logs` is append-only and immutable — no updates or deletes, ever, by anyone. Named `discounts` are BO-defined; terminal operators select from the list — free-entry discount amounts are a BO-role privilege (see `staff-spec.md`). Product `cost` is optional and **portal-only** — excluded from terminal catalog payloads; `cost_snapshot` freezes it at sale time for margin history, and a null cost reports margin as *unknown*, never as zero.

## 7. Money & Time Rules

- **Integer centavos everywhere**; report aggregations cast to `bigint`. Launch is **PHP-only** — the `currency` field is validated to PHP and reserved for later.
- **Rounding:** half-up at every money-producing step (line % discount, order % discount, service charge, VAT extraction, `qty × unit_price` for weight items). **Round per line, then sum** — printed lines must always add up to the printed total; never round a precise grand total.
- **VAT:** prices are VAT-inclusive (PH convention); included VAT = `total × rate ÷ (1 + rate)` from the business `tax_rate`. Launch targets **VAT-registered businesses only**; non-VAT / percentage-tax mode is a later phase (§14).
- **Service charge:** `round(service_charge_rate × discounted subtotal)`, applied to dine-in orders only, shown as its own receipt line, folded into the VAT-inclusive total. Default 0%.
- **SC/PWD (simplified, day one):** on qualifying lines the VAT comes off first (`÷ (1 + rate)`), then 20% off. A line takes the SC/PWD discount **or** a promotional discount — whichever is higher, never both (the PH no-double-discount rule). ID number and name are recorded on the sale, printed on the receipt, and VAT-exempt sales appear in the tax breakdown; reports expose SC/PWD-discount and VAT-exempt columns for BIR. Group (per-person) allocation and the service-charge exemption: later phase (§14).
- **Cash rounding:** none — cash is charged at exact centavos. Small over/short noise at shift close is expected and absorbed by the over/short display; opt-in cash rounding joins the later list only if pilots ask (§14).
- **Business day:** daily reports bucket on each business's `day_start_time` (default midnight; a 2 AM café sets 04:00). Z-readings remain per-shift, so the two never conflict.
- **Time:** timestamps store as UTC and display as Asia/Manila. In the online phase the server's clock is authoritative; `created_at_device` is recorded alongside. Per-business timezones wait for the multi-currency era.

## 8. Account & Device Lifecycle

- **Provisioning:** platform admin creates the BO account → invite email (Resend) with an expiring set-password link. The BO chooses their own password; the platform never knows it. Activation also seeds a **demo business** (`is_demo`): sample catalog and stock, fully working POS, `DEMO-` prefixed receipts, excluded from real report rollups and from `max_businesses`, resettable to seed — so training never pollutes real data.
- **Suspension — two tiers:** *default suspend* locks portal access immediately but lets any open shift finish selling, hard-capped at 24 hours; *hard suspend* kills every token instantly (compromise or abuse). Both are a status check in the API guards.
- **Terminals:** the portal lists every terminal with branch, paired date, and `last_seen_at`. **Remote unpair** revokes the device token — the next request from that device gets a 401 and the app resets to the pairing screen.
- **Closure:** the BO receives an export bundle — a zip of CSVs (catalog, sales, payments, shifts, stock movements, activity log), generated by the same code as report exports — then all tenant data is **hard-deleted after a 90-day grace period**. This is the sole exception to audit-log immutability: immutable in life, erased at end of life.

## 9. API Surface (v1)

- `/admin/*` — platform admin (BO CRUD, limits, metrics, read-only tenant data & activity-log inspector)
- `/portal/*` — BO portal (dashboard (the at-a-glance landing — `analytics-spec.md` §0), businesses, branches, catalog, settings, stock transfers, terminal management, **Analytics** — see `analytics-spec.md` — with CSV exports, notifications, activity log)
- `/pos/*` — terminal pairing, refund PIN verification
- `/sync/pull`, `/sync/push` — terminal sync (milestone 4)

## 10. POS Feature Set (MVP)

Detailed in **`pos-spec.md`** — the terminal app's own feature spec (screens, flows, offline behavior, non-goals). Summary: grid/barcode sale flow with variants, modifiers, weight quantities, and open-price misc lines; price-lock at add-to-cart; named-list and SC/PWD discounts plus optional service charge; shift-scoped hold & resume; single-method payments with cash change; VAT-inclusive 58/80mm receipts with optional printing; ungated voids and PIN-gated refunds; terminal-tied shifts with Z report; hard zero-stock block with on-the-spot adjustments; and a sync status strip. The `business_type` setting shifts default UI emphasis (barcode-first for retail, grid-first for F&B) over one shared core.

## 11. Activity Logging

Every action from the BO downward — including every terminal, and future staff when that phase arrives — is recorded in an append-only, immutable audit trail. The trail is tenant data, scoped per business.

- **Captured:** every mutation (catalog and price changes, settings, branches, terminal pairing, sales, voids, refunds and their PIN approvals, shift open/close, cash in/out, stock adjustments and transfers), auth events (portal logins, pairing), **failures** (failed logins, failed PIN entries with the attempted identity, permission denials), and **sensitive reads** (report views, activity-log access, CSV exports). Plain navigation between screens is analytics, not audit — out of scope.
- **Mechanism:** one choke point. The Prisma wrapper that enforces tenant scope (§4) also writes the audit row for every write; a Nest interceptor supplies actor and action context via request-scoped storage. Nothing escapes the log because nothing bypasses the wrapper.
- **Row — complete info:** who (actor + role, session/token id), what (`action`, entity, and full state: creates log the entire created record, updates log before/after of changed fields, deletes/archives log the full prior state), where (business/branch, IP, device/user-agent, terminal code), when (server timestamp, plus device timestamp for terminal events), correlated by request id.
- **Visibility:** the BO portal gets an Activity Log screen, filterable by business, branch, actor, action, and date. Readable by the platform admin (§4) — quietly; platform views are recorded only in the platform-side admin log. Immutable to everyone, including the BO and the platform. The admin log meets the identical completeness and immutability standard — every user, both scopes, same rigor.
- When the offline layer lands (§5), terminal audit rows queue and sync like every other append-only event. Retention and archival policy: open item (§14).

## 12. Operations

- **Hosting:** Nest API on **Render** (Singapore region, small always-on paid instance — never the spin-down free tier); Next apps on **Vercel**; Supabase project in **ap-southeast-1 (Singapore)**. Provider choice is flagged for re-evaluation before launch; the architecture is host-agnostic (long-running Node + Postgres + static apps). Domains — working convention: `sentry.com` (landing), `app.sentry.com` (BO portal + platform admin), `pos.sentry.com` (terminal), `api.sentry.com` (API). The literal `sentry.com` is registered to a third party, so the acquired production domain replaces this convention everywhere at deploy time — a config change only; domains never appear in code.
- **Staging:** a second Supabase project (free tier) plus a second Render service, mirroring production.
- **Backups:** Supabase daily backups on from day one; the restore procedure gets tested once before pilots onboard.
- **Monitoring:** a free uptime monitor pings the API health endpoint so the platform knows about an outage before a BO calls. **Sentry.io** (the error tracker — no relation to the product name) on the API and both apps — uptime says it's down, Sentry.io says why.
- **Outage reality:** until milestone 4, no network = no selling; pilot BOs have accepted this explicitly. Sales taken on paper during an outage live outside the system (back-entry: open item, §14).
- **Support:** email only, with the response expectation written into the ToS — same business day is the working promise.
- **Legal:** Terms of Service + Privacy Policy live *before* pilot onboarding. The PH Data Privacy Act applies to the platform as a personal-information controller; templates get lawyer review before use, and the privacy policy must disclose platform read access to tenant data.
- **Onboarding note:** platform access is read-only, so the platform still cannot encode catalogs for a BO — onboarding help happens beside the BO on their own session. Prefer pilot stores with modest catalogs until bulk import ships (§14).

## 13. Milestones

1. **Foundation (online):** schema + migrations, auth (TOTP 2FA for the platform admin, invite + reset emails via Resend, throttling/lockout), platform admin panel, BO portal — create businesses, branches, catalog, named discounts
2. **POS core (online):** terminal pairing, full sale → payment → receipt → shift-close flow, named-discount picker, SC/PWD and service-charge handling, misc lines, weight quantities, refund PIN gate — terminal calling the API directly
3. **The Analytics section (`analytics-spec.md`) with CSV export, daily summary emails, low-stock and expiring-soon notifications, inventory reconciliation, stock-take mode, expiry batches, branch transfers, terminal management, polish** — the complete online product
4. **Offline layer:** Dexie local mirror, delta pull, push queue, offline receipt sequences, Serwist shell caching

Sync-ready conventions hold from milestone 1 (UUIDs everywhere, stock as movement events); the engine itself is milestone 4.

## 14. Next Phases & Open Decisions

**Staff phase (next implementation):** fully specified in **`staff-spec.md`** — Manager and Cashier roles, the permission matrix, one-cashier-per-drawer shift accountability, branch-scoped manager portal, offline PIN unlock.

**Later:** customers + loyalty + utang/tab accounts (charge-to-account, settlements, balance reports) · suppliers and purchase orders · per-branch price overrides · real GCash/Maya QR integration · tables + kitchen display/printer routing · BO billing and subscription plans · non-VAT / percentage-tax mode · optional 2FA for BOs · bulk CSV catalog import · per-sale order notes · delivery order type (fee, contact) · opt-in cash rounding · SC/PWD group allocation & service-charge exemption · scale hardware integration · F&B recipe/ingredient inventory (ingredient catalog, per-product recipes, modifier deductions) · hard batch allocation & recall traceability · weighted-average cost option · two-step (in-transit) branch transfers · back-entry of outage (paper) sales · UI localization (Tagalog/Bisaya) · BIR accreditation requirements for PH receipts · audit-log retention & archival policy.
