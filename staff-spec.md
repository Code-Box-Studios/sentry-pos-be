# Sentry — Staff Phase Spec

**Phase:** next implementation after MVP · **Updated:** 2026-08-18

Companion to `project-spec.md` and `pos-spec.md`. Everything here activates when staff accounts ship; the MVP already carries the hooks — the PIN gate, the audit trail, and the named-discounts list.

## 1. Roles

- **Cashier** — a terminal-only identity: unlocks with a PIN, sells, owns a drawer per shift. No portal, but a **My activity** view on the terminal shows their own sales, shift history, and over/short record.
- **Manager** — full terminal operations plus **branch-scoped portal access** (email + password login).
- **BO** — unchanged: owns identities, catalog, the discount list, and settings.

## 2. Permission Matrix

| Action | Cashier | Manager | BO |
|---|---|---|---|
| Sell, hold/resume | ✓ | ✓ | ✓ |
| Discounts from the named list | ✓ select | ✓ select | ✓ |
| Free-entry discount amount | — | — | ✓ |
| Misc (open-price) line | ✓ *watched* | ✓ | ✓ |
| Void (within shift) | manager PIN | ✓ | ✓ |
| Refund (anytime) | manager PIN | ✓ own PIN | ✓ own PIN |
| Cash in / out | ✓ logged | ✓ | ✓ |
| Stock adjustment | manager PIN | ✓ | ✓ |
| Reprint (stamped) | ✓ logged | ✓ | ✓ |
| Shift open/close | own drawer only | ✓ | ✓ |
| Terminal pairing / remote unpair | — | portal, own branches | ✓ |
| Catalog & discount-list editing | — | read-only | ✓ |
| Cost / margin visibility | — | — | ✓ |
| Staff accounts & PIN resets | — | — | ✓ |
| See activity | own records only | own branches, downward | everything in the business |

"Watched" = ungated but surfaced: misc rings appear per-cashier as a % of sales, and the per-business toggle can disable misc entirely.

## 3. Approval Mechanics

In-the-moment and in-person: the manager keys their PIN on the cashier's terminal, and the audit row records **both identities** — who requested, who approved. No remote approvals in v1.

## 4. Shifts & Attribution

One cashier per shift per drawer. `shifts` gains `staff_id`; every sale, movement, and over/short belongs to exactly one person. Handover is close-with-count → reopen-with-count. The mid-shift lock screen unlocks only for the shift's cashier; a manager PIN approves actions without taking over the drawer; relief with a drawer transfer is a real shift change. **Blind close** (hide expected cash until the cashier has counted) ships as a BO-configurable toggle, off by default.

## 5. Auth Model

The terminal lock screen shows the roster of active staff assigned to the branch — **tap your name, then key your PIN**. Name-first is load-bearing: it's what lets a failed attempt be logged against the identity that was claimed. The portal, by contrast, is a plain email + password form; role is derived from the account, never asked.

PINs are **6 digits** everywhere. Cashiers are PIN-only — **6-digit PINs** (argon2 hashes; synced for offline unlock per project-spec §5 once the offline phase lands). Managers hold an email + password for the portal and a 6-digit PIN for terminal approvals. The platform-wide throttle/lockout applies to every PIN, and every failed PIN entry is logged with the attempted identity, device, and terminal — probing shows up in the activity log before it ever succeeds. Staff accounts are **fully BO-managed**: only the BO creates staff, edits their details and roles, assigns branches, resets PINs and manager passwords, and deactivates — deactivation kills access immediately. Staff with sales history are deactivated, never deleted, so every past sale stays attributed to its person.

## 6. Manager Portal Scope

Assigned branches only (`staff_branches`): the **Analytics** section scoped to their branches (`analytics-spec.md`) — per-cashier columns included, the Profit & Leaks tab and all cost/margin columns excluded — stock with adjustments and receiving, transfers *out of* their branch, the branch activity log (operational entries only — sales, shifts, cash, stock, terminals, cashier activity; business-level entries like catalog edits, settings, and staff administration remain BO-only), branch low-stock notifications, branch terminals with remote unpair, and CSV export of their branch reports (logged like all exports). Never: other branches or businesses, business settings, catalog or discount editing, cost, staff administration.

## 7. Schema Additions

`staff` (business_id, name, role manager|cashier, email?, password_hash?, pin_hash, active) · `staff_branches` · `staff_id` on `shifts`, `sales`, and `stock_movements` · approver identity in audit metadata for gated actions. The `discounts` table itself ships in the MVP.

## 8. Reporting Additions

Per-cashier: sales, voids and refunds requested, misc as % of sales, over/short history across shifts. Per-discount-name totals exist from the MVP onward.

## 9. Deliberate v1 Simplifications

The matrix above ships as **fixed rules** — a BO-configurable permission editor is a later enhancement. No remote approvals. No scheduling or timekeeping; this is a POS, not a bundy clock.
