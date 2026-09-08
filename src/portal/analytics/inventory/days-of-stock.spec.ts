import { daysOfStock, isLow, valuationC } from './days-of-stock';

describe('daysOfStock', () => {
  it('divides stock by the trailing average daily sales', () => {
    // 30 sold over 10 days = 3/day; 12 on hand lasts 4 days.
    expect(daysOfStock(12, 30, 10)).toBeCloseTo(4);
  });

  // An infinite runway is not a number a report can render, and 0 would say
  // "out today" about something that simply never sells.
  it('is null when nothing sold in the period', () => {
    expect(daysOfStock(12, 0, 10)).toBeNull();
  });

  it('is null when the period is empty', () => {
    expect(daysOfStock(12, 5, 0)).toBeNull();
  });

  it('is zero when there is nothing on the shelf', () => {
    expect(daysOfStock(0, 30, 10)).toBe(0);
  });
});

describe('valuationC', () => {
  it('multiplies quantity by unit cost, rounded half up', () => {
    expect(valuationC(2.5, 333)).toBe(833);
  });

  it('is null when the cost is unknown — never zero', () => {
    expect(valuationC(10, null)).toBeNull();
  });

  it('values an empty shelf at zero when the cost IS known', () => {
    expect(valuationC(0, 500)).toBe(0);
  });
});

describe('isLow', () => {
  it('is true at or below the threshold', () => {
    expect(isLow(3, 10)).toBe(true);
    expect(isLow(10, 10)).toBe(true);
  });

  it('is false above it', () => {
    expect(isLow(11, 10)).toBe(false);
  });

  // No threshold means unmonitored, which is not the same as low.
  it('is false when no threshold is set, however empty the shelf', () => {
    expect(isLow(0, null)).toBe(false);
  });
});
