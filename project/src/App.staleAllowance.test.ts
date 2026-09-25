import { describe, expect, it } from 'vitest';
import { isBridgeAllowanceVerifiedForAmount } from './App';

describe('bridge allowance verification staleness regression', () => {
  it('keeps allowance verified when the on-chain allowance covers the newly selected smaller amount', () => {
    expect(isBridgeAllowanceVerifiedForAmount(5_000_000n, 100_000n, false)).toBe(true);
    expect(isBridgeAllowanceVerifiedForAmount(5_000_000n, 1_000_000n, false)).toBe(true);
    expect(isBridgeAllowanceVerifiedForAmount(5_000_000n, 2_000_000n, false)).toBe(true);
    expect(isBridgeAllowanceVerifiedForAmount(5_000_000n, 5_000_000n, false)).toBe(true);
  });

  it('requires a fresh approval when the allowance is below the required amount', () => {
    expect(isBridgeAllowanceVerifiedForAmount(4_999_999n, 5_000_000n, false)).toBe(false);
    expect(isBridgeAllowanceVerifiedForAmount(999_999n, 1_000_000n, false)).toBe(false);
  });

  it('does not mark allowance as verified while the allowance read is still loading', () => {
    expect(isBridgeAllowanceVerifiedForAmount(5_000_000n, 100_000n, true)).toBe(false);
    expect(isBridgeAllowanceVerifiedForAmount(5_000_000n, 2_000_000n, true)).toBe(false);
  });

  it('keeps the valid 5 USDC CCTP allowance path true', () => {
    expect(isBridgeAllowanceVerifiedForAmount(5_000_000n, 5_000_000n, false)).toBe(true);
  });
});
