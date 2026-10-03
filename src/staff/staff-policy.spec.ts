import { permissionFor } from './staff-policy';

describe('staff permission matrix', () => {
  it.each([
    ['owner', 'terminal_sell', 'allow'],
    ['owner', 'terminal_free_discount', 'allow'],
    ['owner', 'terminal_refund', 'self_pin'],
    ['owner', 'portal_staff_admin', 'allow'],
    ['manager', 'terminal_sell', 'allow'],
    ['manager', 'terminal_void', 'allow'],
    ['manager', 'terminal_refund', 'self_pin'],
    ['manager', 'portal_reports', 'allow'],
    ['manager', 'portal_profit', 'deny'],
    ['manager', 'portal_staff_admin', 'deny'],
    ['cashier', 'terminal_sell', 'allow'],
    ['cashier', 'terminal_void', 'approval'],
    ['cashier', 'terminal_refund', 'approval'],
    ['cashier', 'terminal_stock_adjust', 'approval'],
    ['cashier', 'terminal_free_discount', 'deny'],
    ['cashier', 'portal_reports', 'deny'],
    ['platform_admin', 'terminal_sell', 'deny'],
  ] as const)('%s + %s yields %s', (role, action, expected) => {
    expect(permissionFor(role, action)).toBe(expected);
  });
});
