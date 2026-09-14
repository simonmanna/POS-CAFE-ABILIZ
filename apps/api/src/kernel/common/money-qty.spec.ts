import { qtyMul } from './money';

describe('qtyMul', () => {
  it('multiplies without binary floating-point drift', () => {
    expect(0.1 * 3).not.toBe(0.3);
    expect(qtyMul(0.1, 3)).toBe(0.3);
    expect(qtyMul(0.018, 7)).toBe(0.126);
    expect(qtyMul('0.018', 100)).toBe(1.8);
  });

  it('accumulates exactly across many recipe lines', () => {
    let total = 0;
    for (let i = 0; i < 100; i++) total = qtyMul(total + qtyMul(0.018, 1), 1);
    expect(total).toBe(1.8);
  });

  it('rounds to the 6-dp ledger scale and handles multipliers', () => {
    expect(qtyMul(1, 1 / 3)).toBe(0.333333);
    expect(qtyMul('18', '0.001', '1.5', 4)).toBe(0.108);
  });
});
