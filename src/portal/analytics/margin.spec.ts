import { marginOf } from './margin';

describe('marginOf', () => {
  // The single most damaging silent error available in this codebase: a zero
  // cost reports 100% margin on a product whose cost nobody recorded.
  it('reports unknown, not zero, when no line carried a cost', () => {
    expect(marginOf(0, 0, 0)).toEqual({ grossProfitC: null, marginPct: null });
  });

  it('computes profit and margin over the costed lines only', () => {
    expect(marginOf(3, 10000, 6000)).toEqual({
      grossProfitC: 4000,
      marginPct: 40,
    });
  });

  it('reports a negative margin when cost exceeded revenue', () => {
    expect(marginOf(1, 1000, 1500)).toEqual({
      grossProfitC: -500,
      marginPct: -50,
    });
  });

  it('reports margin as null when costed revenue is zero but a cost existed', () => {
    // A fully discounted costed line: profit is knowable, margin is not.
    expect(marginOf(1, 0, 500)).toEqual({
      grossProfitC: -500,
      marginPct: null,
    });
  });

  it('ignores uncosted volume entirely rather than diluting the margin', () => {
    // Caller passes only the costed figures; uncosted revenue is reported
    // separately so the reader can see the coverage.
    expect(marginOf(1, 10000, 5000).marginPct).toBe(50);
  });
});
