export type OperatorRole = 'owner' | 'manager' | 'cashier' | 'platform_admin';

export type StaffAction =
  | 'terminal_sell'
  | 'terminal_hold'
  | 'terminal_named_discount'
  | 'terminal_free_discount'
  | 'terminal_misc'
  | 'terminal_void'
  | 'terminal_refund'
  | 'terminal_cash_movement'
  | 'terminal_stock_adjust'
  | 'terminal_reprint'
  | 'terminal_shift'
  | 'terminal_my_activity'
  | 'portal_reports'
  | 'portal_profit'
  | 'portal_stock'
  | 'portal_terminals'
  | 'portal_activity'
  | 'portal_catalog_read'
  | 'portal_catalog_write'
  | 'portal_settings'
  | 'portal_staff_admin';

export type Permission = 'allow' | 'approval' | 'self_pin' | 'deny';

export function permissionFor(
  role: OperatorRole,
  action: StaffAction,
): Permission {
  if (role === 'platform_admin') return 'deny';
  if (role === 'owner')
    return action === 'terminal_refund' ? 'self_pin' : 'allow';

  switch (action) {
    case 'terminal_free_discount':
    case 'portal_profit':
    case 'portal_catalog_write':
    case 'portal_settings':
    case 'portal_staff_admin':
      return 'deny';
    case 'portal_reports':
    case 'portal_stock':
    case 'portal_terminals':
    case 'portal_activity':
    case 'portal_catalog_read':
      return role === 'manager' ? 'allow' : 'deny';
    case 'terminal_void':
    case 'terminal_stock_adjust':
      return role === 'cashier' ? 'approval' : 'allow';
    case 'terminal_refund':
      return role === 'cashier' ? 'approval' : 'self_pin';
    default:
      return 'allow';
  }
}
