# Staff Access Design

**Status:** Approved direction; implementation brief.  
**Scope:** Backend, POS terminal, and portal. Staff access ships and is verified before offline sync.  
**Existing intent:** `sentry-pos-fe/staff-spec.md`, plus the owner's decisions in this conversation.

## Outcome

The business owner can operate a terminal under their own identity, create managers and cashiers, and see who performed every operation. Managers work on assigned branches in the portal and terminal. Cashiers use only the terminal. Every shift has one responsible operator; a privileged approval never transfers that responsibility. The current online product continues to work, and the interface follows the existing Sentry design language.

## Language and boundaries

- **User:** one human security principal for password/PIN checks, lockouts, and session revocation. Roles are platform admin, owner, manager, and cashier.
- **Staff profile:** a manager or cashier's business membership, display name, active state, and branch assignments. An owner has no staff profile.
- **Terminal:** a paired device with its own token and fixed branch; it is not the human actor.
- **Operator session:** a human's unlocked session on one terminal. It is distinct from the terminal's device token and from a portal session.
- **Shift operator:** the human accountable for the drawer from opening through ordinary close. **Approver** and **emergency closer** are separately recorded humans.

One staff profile belongs to one business. Its branch assignments must belong to that same business. A manager must have an email and at least one assigned branch. A cashier may have no email and must have at least one assigned branch. The owner's terminal access covers their own businesses. Platform admins never operate a tenant terminal.

## Persistence and migration

Expand `User.role` for manager and cashier and allow nullable unique email for PIN-only cashiers. Preserve the existing owner and platform admin identities. Add staff profile and branch assignment tables with database foreign keys and uniqueness constraints. Keep manager email unique platform-wide, case-normalized consistently with login. No placeholder email addresses.

Add hashed, expiring, single-use temporary PIN challenges with purpose, attempt count, and delivery mode. Add hashed opaque operator sessions bound to `userId`, `terminalId`, `branchId`, idle timestamp, absolute expiry, and revocation. A session lasts at most 12 hours and expires after five minutes without a human action. It is held in terminal memory only; reload requires unlocking. Device-only catalog refresh does not prolong it.

Add nullable historical attribution columns for `Shift.operatorUserId`, `Shift.closedByUserId`, `Sale.operatorUserId`, `Sale.statusRequestedByUserId`, `Sale.statusApprovedByUserId`, `ShiftCashMovement.operatorUserId`, and `StockMovement.operatorUserId`/`approvedByUserId`. Add `Shift.emergencyCloseReason` and a business `blindCloseEnabled` setting (default false). Existing rows remain nullable and display as legacy terminal activity; do not invent an owner or staff actor. New writes require the appropriate human identity. Sale-generated stock movements inherit the sale operator; reversal movements retain the requester and approver.

Audit actors become `owner`, `staff`, `terminal`, or `platform_admin`; staff audit metadata snapshots the role at action time. Request context keeps the device identity separately. A protected mutation's audit row records the requester and, where required, the approver. Failed PIN attempts record the claimed identity and terminal, never the PIN. Audit rows remain immutable.

## Onboarding and credential lifecycle

Only an owner may create, edit, assign, reset, deactivate, or reactivate staff. Manager creation requires an email; a cryptographically generated six-digit temporary PIN is emailed. Cashier creation returns a temporary PIN to the owner once on the Staff page; it is never retrievable afterward. Each temporary PIN expires after 15 minutes, permits at most five failed attempts, is stored as a slow hash, and is invalidated by resend/reset or use. Delivery failure leaves the manager pending and allows a fresh resend; it does not reveal the PIN in the API response.

First manager sign-in uses email plus temporary PIN and requires setting a portal password and a separate permanent six-digit terminal PIN in one completed setup before normal portal access. First cashier terminal unlock uses the temporary PIN and requires replacing it with a permanent six-digit PIN before normal operation. Existing permanent PIN lockout rules apply to every person. The owner uses their existing six-digit portal PIN for terminal unlock; if none exists, the terminal directs them to set one in portal settings.

Owner-initiated PIN reset revokes operator sessions and issues a fresh temporary PIN through the staff member's onboarding delivery channel. Manager password reset revokes portal refresh sessions and sends a new short-lived setup challenge by email. Deactivation and role/branch changes revoke affected sessions immediately online. Reactivation requires a fresh credential setup if the old PIN was reset. Historical attribution and audit records remain intact. Staff with operational history are deactivated, never deleted.

## Authorization and terminal flow

Keep device-token validation for pairing and branch scope. Public-to-device reads required for the roster, catalog, and current shift may use the device identity; all operational mutations and personal activity reads require an operator session. The client sends its device bearer token and an independent operator token. The backend checks both, their binding, current staff status, branch assignment, owner status, session age, and role on every protected request. A cashier cannot obtain a portal token. Portal authorization derives role from the database, not only a JWT claim or hidden navigation link.

The paired terminal shows the active branch roster with the owner and assigned staff; a person selects their name before entering their PIN. The lock screen is the startup route, manual Lock target, and five-minute inactivity target. Locking preserves the cart, pending sale draft, and shift. Only the shift operator may unlock and resume an open shift. A pending sale retains its original client UUID and operator identity; after an ambiguous response the operator checks/retries that same request. A deactivated operator cannot submit or retry. A read-only sale lookup may still reveal whether the earlier request committed.

One terminal has one open shift. Its operator owns all sales and ordinary cash movements until close. Handover is count-and-close followed by a new count-and-open. Held and pending carts must be completed or explicitly discarded before close. A manager or owner assigned to the branch may emergency-close a deactivated operator's shift with counted cash and a required reason. The shift remains attributed to its original operator, and the closer is recorded separately. No sale may be added under a deactivated operator.

The fixed permission matrix from `staff-spec.md` is enforced in backend policies. Cashiers may sell, choose named discounts, use enabled miscellaneous lines, log cash movements, reprint with a stamp, and view only their own activity. Owner-only free-entry discounts remain owner-only. Manager and owner can operate terminals. Cashier requests for void, refund, or stock adjustment require a selected manager or owner to enter their own PIN in person. Direct manager/owner refunds require their own PIN; direct manager/owner voids and stock adjustments follow the matrix. The approval is a one-action authorization and never switches the operator session. The backend rechecks the requester, approver, sale/shift scope, and business rule in the same transaction as the mutation. Reasons remain mandatory where already required.

Blind close hides expected cash until the operator submits the count when enabled; it does not hide the post-close Z report. Default is off. The business owner alone changes this setting.

## Manager portal and reporting

The owner gets a responsive Staff page within the existing business portal: list, create, branch assignment, role change, reset, deactivate/reactivate, and one-time cashier PIN reveal. Status, errors, and confirmation use the existing cards, pill actions, badges, typography, spacing, and form components. Terminal lock and approval screens use the same tokens in a compact operational layout. Customer receipts retain business-only branding.

Managers see only assigned branches and their operational analytics, stock/receiving/adjustments, transfers out, terminal management, operational activity, branch alerts, and scoped CSV exports. They cannot access profit/leaks, cost/margin fields, business/account settings, catalog or discount editing, staff administration, or another business/branch. Portal navigation reflects these rules, and every API query/export independently enforces them. Transfer source must be an assigned branch; destination may be another branch of the same business only as the existing transfer rules permit. Manager activity excludes business-level and account-level events. Cashier activity on terminal shows only their sales, shifts, and over/short. Owner sees all.

Per-cashier reporting covers sales, requested void/refund counts, miscellaneous-line share, and shift over/short. Preserve existing money arithmetic and UTC storage/Asia/Manila display. Legacy rows show an explicit unattributed label. A role change never rewrites historical role snapshots.

## Errors and recovery

Expired/used temporary PINs, wrong PINs, lockout, revoked operator sessions, branch removal, and deactivation fail closed with stable API codes and actionable terminal messages. PIN failures never disclose whether another identity has an account. A remote terminal unpair clears local operator state on the next response. Existing pending-payment idempotency is preserved. Owner suspension behavior follows the current device guard; staff access does not grant a bypass.

## Verification

Use test-first changes for credential lifecycle, five-minute expiry, owner operation, cashier/manager matrix, approval identity and race checks, emergency close, branch isolation, and legacy attribution. Exercise the real API from terminal and portal integration suites, including direct unauthorized URLs/exports and manager cost leakage. Run all three repository test suites, lint/typechecks and production builds. Use a real browser for roster/lock, owner Staff page, manager portal, and responsive layouts. Refresh Graft after major code changes.

## Out of scope

Offline sync is the next separate implementation. No configurable permission editor, remote approvals, scheduling/timekeeping, split payments, or partial refunds.
