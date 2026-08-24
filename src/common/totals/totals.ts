import { halfUp, mulRate, pct, vatIncluded } from './money';
import { mulQtyPriceC } from './qty';
import { lineUnitWithModsC, type Cart, type DiscountSpec } from './cart';

export interface LineTotals {
  lineId: string;
  grossC: number; // mulQtyPriceC(qty, unitWithMods) — rounded per line
  promoDiscountC: number; // candidate promo amount (capped ≤ grossC)
  scPwdDiscountC: number; // candidate SC/PWD amount (0 unless marked & cart.scPwd)
  applied: 'promo' | 'scpwd' | null; // higher-of; tie → scpwd; null when both 0
  netC: number; // grossC − applied amount
}

export interface CartTotals {
  lines: LineTotals[];
  subtotalC: number; // Σ grossC
  promoDiscountC: number; // Σ applied promo + order discount
  scPwdDiscountC: number; // Σ applied scpwd
  discountedSubtotalC: number; // subtotal − promoDiscount − scPwdDiscount
  serviceChargeC: number; // dine-in only: mulRate(discountedSubtotal, scRate)
  totalC: number; // discountedSubtotal + serviceCharge
  vatExemptSalesC: number; // Σ netC of scpwd-applied lines
  vatC: number; // vatIncluded(totalC − vatExemptSales, taxRate)
  vatableSalesC: number; // (totalC − vatExemptSales) − vatC
}

/** Discounts never push a line or an order negative (pos-spec §4). */
function discountAmountC(d: DiscountSpec | null, baseC: number): number {
  if (!d || baseC <= 0) return 0;
  const raw = d.kind === 'percent' ? pct(baseC, d.value) : d.value;
  return Math.min(raw, baseC);
}

export function computeTotals(
  cart: Cart,
  s: { taxRate: number; serviceChargeRate: number },
): CartTotals {
  const lines: LineTotals[] = cart.lines.map((line) => {
    const grossC = mulQtyPriceC(line.qty, lineUnitWithModsC(line));
    const promoDiscountC = discountAmountC(line.discount, grossC);

    // SC/PWD: VAT comes off first, then 20% (project-spec §7).
    let scPwdDiscountC = 0;
    if (cart.scPwd && line.scPwdMarked) {
      const base = halfUp(grossC / (1 + s.taxRate));
      scPwdDiscountC = grossC - pct(base, 80);
    }

    // A line takes SC/PWD or a promo, whichever is higher — never both. Ties go to SC/PWD.
    let applied: LineTotals['applied'] = null;
    if (promoDiscountC > 0 || scPwdDiscountC > 0) {
      applied = scPwdDiscountC >= promoDiscountC ? 'scpwd' : 'promo';
    }
    const appliedC =
      applied === 'scpwd'
        ? scPwdDiscountC
        : applied === 'promo'
          ? promoDiscountC
          : 0;

    return {
      lineId: line.id,
      grossC,
      promoDiscountC,
      scPwdDiscountC,
      applied,
      netC: grossC - appliedC,
    };
  });

  const subtotalC = lines.reduce((sum, l) => sum + l.grossC, 0);
  const linePromoC = lines.reduce(
    (sum, l) => (l.applied === 'promo' ? sum + l.promoDiscountC : sum),
    0,
  );
  const scPwdDiscountC = lines.reduce(
    (sum, l) => (l.applied === 'scpwd' ? sum + l.scPwdDiscountC : sum),
    0,
  );

  // SC/PWD lines are already discounted — an order discount must not double up on them.
  const orderBaseC = lines.reduce(
    (sum, l) => (l.applied === 'scpwd' ? sum : sum + l.netC),
    0,
  );
  const orderDiscountC = discountAmountC(cart.orderDiscount, orderBaseC);

  const promoDiscountC = linePromoC + orderDiscountC;
  const discountedSubtotalC = subtotalC - promoDiscountC - scPwdDiscountC;
  const serviceChargeC =
    cart.orderType === 'dine_in'
      ? mulRate(discountedSubtotalC, s.serviceChargeRate)
      : 0;
  const totalC = discountedSubtotalC + serviceChargeC;

  const vatExemptSalesC = lines.reduce(
    (sum, l) => (l.applied === 'scpwd' ? sum + l.netC : sum),
    0,
  );
  const vatC = vatIncluded(totalC - vatExemptSalesC, s.taxRate);
  const vatableSalesC = totalC - vatExemptSalesC - vatC;

  return {
    lines,
    subtotalC,
    promoDiscountC,
    scPwdDiscountC,
    discountedSubtotalC,
    serviceChargeC,
    totalC,
    vatExemptSalesC,
    vatC,
    vatableSalesC,
  };
}
