import { computeTotals } from './totals';
import type { Cart, CartLine } from './cart';

const S = { taxRate: 0.12, serviceChargeRate: 0.05 };

function line(
  partial: Partial<CartLine> & {
    name: string;
    unitPriceC: number;
    qty: number;
  },
): CartLine {
  return {
    id: crypto.randomUUID(),
    productId: 'p',
    variantId: null,
    soldBy: 'unit',
    modifiers: [],
    discount: null,
    scPwdMarked: true,
    trackStock: false,
    ...partial,
  };
}
function cart(lines: CartLine[], partial: Partial<Cart> = {}): Cart {
  return {
    id: crypto.randomUUID(),
    orderType: 'none',
    lines,
    orderDiscount: null,
    scPwd: null,
    ...partial,
  };
}

test('design cart, spec-correct: subtotal 423.25 → total 432.86', () => {
  const c = cart(
    [
      line({
        name: 'Iced Latte — Large',
        unitPriceC: 14500,
        qty: 1,
        modifiers: [
          {
            groupId: 'mg-milk',
            modifierId: 'mod-oat',
            name: 'Oat milk',
            priceDeltaC: 2500,
          },
        ],
      }),
      line({ name: 'Pan de sal', unitPriceC: 1200, qty: 6 }),
      line({
        name: 'Ensaymada',
        unitPriceC: 5500,
        qty: 2,
        discount: {
          source: 'named',
          discountId: 'disc-merienda',
          name: 'Merienda 10%',
          kind: 'percent',
          value: 10,
        },
      }),
      line({
        name: 'Jasmine rice',
        unitPriceC: 9500,
        qty: 0.75,
        soldBy: 'weight',
      }),
    ],
    { orderType: 'dine_in' },
  );
  const t = computeTotals(c, S);
  expect(t.lines.map((l) => l.grossC)).toEqual([17000, 7200, 11000, 7125]);
  expect(t.subtotalC).toBe(42325);
  expect(t.promoDiscountC).toBe(1100);
  expect(t.scPwdDiscountC).toBe(0);
  expect(t.discountedSubtotalC).toBe(41225);
  expect(t.serviceChargeC).toBe(2061); // 5% of 412.25 = 2061.25 → 2061
  expect(t.totalC).toBe(43286);
  expect(t.vatC).toBe(4638);
  expect(t.vatableSalesC).toBe(38648);
  expect(t.vatExemptSalesC).toBe(0);
});

test('service charge only on dine-in', () => {
  const c = cart([line({ name: 'Espresso', unitPriceC: 8500, qty: 1 })], {
    orderType: 'takeout',
  });
  expect(computeTotals(c, S).serviceChargeC).toBe(0);
});

test('SC/PWD: VAT off then 20% off; sale becomes VAT-exempt', () => {
  const c = cart([line({ name: 'Espresso', unitPriceC: 8500, qty: 1 })], {
    scPwd: { idNo: 'SC-1234-5678', name: 'Jose Cruz' },
  });
  const t = computeTotals(c, S);
  // base = 8500/1.12 = 7589.29 → 7589; pay = 80% = 6071.2 → 6071; discount 2429
  expect(t.scPwdDiscountC).toBe(2429);
  expect(t.totalC).toBe(6071);
  expect(t.vatExemptSalesC).toBe(6071);
  expect(t.vatC).toBe(0);
  expect(t.vatableSalesC).toBe(0);
});

test('higher-of rule: scpwd 28.57% beats promo 25%, loses to promo 30%', () => {
  const base = { name: 'Item', unitPriceC: 10000, qty: 1 };
  const scpwdCart = (promoPct: number) =>
    cart(
      [
        line({
          ...base,
          discount: { source: 'free', kind: 'percent', value: promoPct },
        }),
      ],
      { scPwd: { idNo: 'X', name: 'Y' } },
    );
  const t25 = computeTotals(scpwdCart(25), S);
  expect(t25.lines[0].applied).toBe('scpwd'); // 2857 > 2500
  expect(t25.scPwdDiscountC).toBe(2857);
  expect(t25.promoDiscountC).toBe(0); // promo not applied → not counted
  const t30 = computeTotals(scpwdCart(30), S);
  expect(t30.lines[0].applied).toBe('promo'); // 3000 > 2857
  expect(t30.promoDiscountC).toBe(3000);
  expect(t30.vatExemptSalesC).toBe(0); // line stays VATable
});

test('discount caps: fixed line discount cannot exceed line; order discount cannot exceed base', () => {
  const c = cart([
    line({
      name: 'Kopiko',
      unitPriceC: 900,
      qty: 1,
      discount: { source: 'free', kind: 'fixed', value: 5000 },
    }),
  ]);
  const t = computeTotals(c, S);
  expect(t.promoDiscountC).toBe(900);
  expect(t.totalC).toBe(0);
  const c2 = cart([line({ name: 'Kopiko', unitPriceC: 900, qty: 1 })], {
    orderDiscount: {
      source: 'named',
      discountId: 'disc-20',
      name: '₱20 off',
      kind: 'fixed',
      value: 2000,
    },
  });
  expect(computeTotals(c2, S).totalC).toBe(0);
});

test('order percent discount excludes scpwd lines from its base', () => {
  const c = cart(
    [
      line({ name: 'A', unitPriceC: 10000, qty: 1 }), // scpwd applies
      line({ name: 'B', unitPriceC: 10000, qty: 1, scPwdMarked: false }), // promo-eligible
    ],
    {
      scPwd: { idNo: 'X', name: 'Y' },
      orderDiscount: { source: 'free', kind: 'percent', value: 10 },
    },
  );
  const t = computeTotals(c, S);
  // A: scpwd → net 7143; B: no line discount → net 10000; order base = 10000 → order disc 1000
  expect(t.scPwdDiscountC).toBe(2857);
  expect(t.promoDiscountC).toBe(1000);
  expect(t.totalC).toBe(10000 + 7143 - 1000);
});

test('misc line participates in totals like any line', () => {
  const c = cart([
    line({ name: 'Tinapa (misc)', unitPriceC: 15000, qty: 1, productId: null }),
  ]);
  expect(computeTotals(c, S).totalC).toBe(15000);
});

test('empty cart totals are all zero', () => {
  const t = computeTotals(cart([]), S);
  expect(t.subtotalC).toBe(0);
  expect(t.totalC).toBe(0);
});
