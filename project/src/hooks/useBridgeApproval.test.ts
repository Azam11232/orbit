import { describe, expect, it } from 'vitest';
import { hasSufficientBridgeAllowance, resolveApprovalAllowanceResult } from './useBridgeApproval';

describe('bridge approval allowance verification', () => {
  it('requires allowance to cover the exact bridge amount', () => {
    expect(hasSufficientBridgeAllowance(0n, 1_000_000n)).toBe(false);
    expect(hasSufficientBridgeAllowance(999_999n, 1_000_000n)).toBe(false);
    expect(hasSufficientBridgeAllowance(1_000_000n, 1_000_000n)).toBe(true);
    expect(hasSufficientBridgeAllowance(2_000_000n, 1_000_000n)).toBe(true);
  });

  it('requires source-paid allowance to cover total debit, including fees', () => {
    const requestedAmount = 5_000_000n;
    const totalDebit = 5_018_687n;
    expect(hasSufficientBridgeAllowance(requestedAmount, totalDebit)).toBe(false);
    expect(hasSufficientBridgeAllowance(totalDebit, totalDebit)).toBe(true);
    expect(hasSufficientBridgeAllowance(totalDebit + 1n, totalDebit)).toBe(true);
  });

  it('prefers a fresh direct allowance read over stale query cache data after approval', () => {
    const result = resolveApprovalAllowanceResult({
      directAllowance: 5_000_000n,
      hookAllowance: 0n,
      requiredAmount: 5_000_000n,
    });
    expect(result.shouldConfirm).toBe(true);
    expect(result.staleCache).toBe(true);
    expect(result.directSufficient).toBe(true);
    expect(result.hookSufficient).toBe(false);
  });

  it('does not accept a missing or zero amount as approved', () => {
    expect(hasSufficientBridgeAllowance(1_000_000n, null)).toBe(false);
    expect(hasSufficientBridgeAllowance(1_000_000n, 0n)).toBe(false);
  });
});
