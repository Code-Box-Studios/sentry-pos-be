import { Business } from '@prisma/client';

/**
 * The FE `BusinessSettings` contract (`domain/types.ts`) — EXACTLY these fields,
 * no more. Notably it carries NO `expiryWarningDays` (portal-only): the POS never
 * sees it. Shared by pairing (Task 16) and the POS catalog pull (Task 17) so both
 * surfaces serialize the business identically.
 */
export interface BusinessSettings {
  id: string;
  name: string;
  type: Business['type'];
  currency: string;
  taxRate: number;
  serviceChargeRate: number;
  allowMiscItems: boolean;
  isDemo: boolean;
  dayStartTime: string;
  receiptHeader: string;
  receiptFooter: string;
}

/** Map a `Business` row (Decimal rates) → the FE `BusinessSettings` shape. */
export function serializeBusinessSettings(b: Business): BusinessSettings {
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    currency: b.currency,
    taxRate: b.taxRate.toNumber(),
    serviceChargeRate: b.serviceChargeRate.toNumber(),
    allowMiscItems: b.allowMiscItems,
    isDemo: b.isDemo,
    dayStartTime: b.dayStartTime,
    receiptHeader: b.receiptHeader,
    receiptFooter: b.receiptFooter,
  };
}
