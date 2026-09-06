import { randomUUID } from 'crypto';
import {
  PaymentMethod,
  Prisma,
  PrismaClient,
  SaleStatus,
} from '@prisma/client';
import { computeTotals } from '../../src/common/totals/totals';
import type {
  Cart,
  CartLine,
  CartModifier,
  DiscountSpec,
} from '../../src/common/totals/cart';

/**
 * Seeds a sale the way `sales.service.persist` does, with totals from the REAL
 * engine (`computeTotals`). Analytics reports are validated against these rows,
 * so they must carry the engine's arithmetic — in particular that
 * `sale_items.unit_price` is the BASE price while the line's gross includes each
 * modifier's `priceDeltaC`.
 *
 * Writes on the raw client deliberately: these are fixtures, not tenant traffic,
 * and going through the choke point would demand a request context.
 */
export interface SeedLine {
  name?: string;
  qty: number;
  unitPriceC: number;
  costC?: number | null;
  productId?: string | null;
  variantId?: string | null;
  modifiers?: CartModifier[];
  discount?: DiscountSpec | null;
  scPwdMarked?: boolean;
}

export interface SeedSaleOptions {
  branchId: string;
  terminalId: string;
  shiftId?: string | null;
  createdAt: Date;
  status?: SaleStatus;
  statusReason?: string | null;
  orderType?: Cart['orderType'];
  taxRate?: number;
  serviceChargeRate?: number;
  scPwd?: { idNo: string; name: string } | null;
  orderDiscount?: DiscountSpec | null;
  discountId?: string | null;
  paymentMethod?: PaymentMethod;
  receiptNo?: string;
  lines: SeedLine[];
}

let receiptCounter = 0;

export async function seedSale(
  raw: PrismaClient,
  options: SeedSaleOptions,
): Promise<{ id: string; subtotal: number; total: number }> {
  const {
    branchId,
    terminalId,
    shiftId = null,
    createdAt,
    status = 'completed',
    statusReason = null,
    orderType = 'takeout',
    taxRate = 0.12,
    serviceChargeRate = 0,
    scPwd = null,
    orderDiscount = null,
    discountId = null,
    paymentMethod = 'cash',
    lines,
  } = options;

  receiptCounter += 1;
  const receiptNo = options.receiptNo ?? `R-${Date.now()}-${receiptCounter}`;

  const cartLines: CartLine[] = lines.map((line, index) => ({
    id: `line-${index}`,
    productId: line.productId ?? null,
    variantId: line.variantId ?? null,
    name: line.name ?? `Item ${index + 1}`,
    soldBy: 'unit',
    qty: line.qty,
    unitPriceC: line.unitPriceC,
    modifiers: line.modifiers ?? [],
    discount: line.discount ?? null,
    scPwdMarked: line.scPwdMarked ?? false,
    trackStock: false,
  }));

  const cart: Cart = {
    id: randomUUID(),
    orderType,
    lines: cartLines,
    orderDiscount,
    scPwd,
  };
  const totals = computeTotals(cart, { taxRate, serviceChargeRate });

  const saleId = randomUUID();
  await raw.sale.create({
    data: {
      id: saleId,
      createdAt,
      branchId,
      terminalId,
      shiftId,
      receiptNo,
      orderType,
      status,
      statusReason,
      subtotal: totals.subtotalC,
      discount: totals.promoDiscountC,
      discountId,
      serviceCharge: totals.serviceChargeC,
      ...(scPwd
        ? { scPwd: scPwd as unknown as Prisma.InputJsonValue }
        : {}),
      scPwdDiscount: totals.scPwdDiscountC,
      vatExemptSales: totals.vatExemptSalesC,
      tax: totals.vatC,
      total: totals.totalC,
      createdAtDevice: createdAt,
      draft: {},
      items: {
        create: cartLines.map((line, index) => {
          const lineTotals = totals.lines[index];
          return {
            createdAt,
            productId: line.productId,
            variantId: line.variantId,
            nameSnapshot: line.name,
            qty: line.qty,
            // The BASE price, exactly as the POS stores it: modifier deltas
            // live in `modifiers` and are added back by the report SQL.
            unitPrice: line.unitPriceC,
            costSnapshot: lines[index].costC ?? null,
            discount: lineTotals.grossC - lineTotals.netC,
            modifiers: line.modifiers as unknown as Prisma.InputJsonValue,
          };
        }),
      },
      payments: {
        create: [
          {
            createdAt,
            method: paymentMethod,
            amount: totals.totalC,
            tendered: totals.totalC,
            change: 0,
          },
        ],
      },
    },
  });

  return { id: saleId, subtotal: totals.subtotalC, total: totals.totalC };
}
