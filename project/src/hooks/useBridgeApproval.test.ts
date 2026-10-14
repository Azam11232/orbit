import { describe, expect, it } from 'vitest';
import { createBridgeApprovalOneShotGuard, getBridgeApprovalActionState, getBridgeApprovalRequest, getBridgeApprovalState, hasSufficientBridgeAllowance, resolveApprovalAllowanceResult } from './useBridgeApproval';
import { getCircleForwardingApprovalAmount, getCircleForwardingApprovalTarget } from '../services/bridge/circleForwarding';
import { ARC_PRIMARY_NETWORK, ETHEREUM_SEPOLIA, getOrbitNetwork } from '../data/networks';
import type { BridgeQuote } from '../types/bridge';

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

  it('shows approval only after the selected route allowance has been read', () => {
    const shared = { hasToken: true, nativeToken: false, hasOwner: true, hasSpender: true, amount: 1_000_000n, isLoading: false, isFetching: false, isError: false };
    expect(getBridgeApprovalState({ ...shared, allowance: 999_999n })).toEqual({ isReady: true, required: true });
    expect(getBridgeApprovalState({ ...shared, allowance: 1_000_000n })).toEqual({ isReady: true, required: false });
    expect(getBridgeApprovalState({ ...shared, allowance: undefined, isLoading: true })).toEqual({ isReady: false, required: false });
    expect(getBridgeApprovalState({ ...shared, allowance: undefined, isError: true })).toEqual({ isReady: false, required: false });
    expect(getBridgeApprovalState({ ...shared, allowance: 1_000_000n, isStale: true })).toEqual({ isReady: false, required: false });
    expect(getBridgeApprovalState({ ...shared, allowance: 999_999n, isStale: false })).toEqual({ isReady: true, required: true });
    expect(getBridgeApprovalState({ ...shared, hasSpender: false, allowance: 0n })).toEqual({ isReady: false, required: false });
  });

  it('uses route-specific forwarding spender and source debit for the allowance check', () => {
    expect(getCircleForwardingApprovalTarget(ARC_PRIMARY_NETWORK.id)).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
    expect(getCircleForwardingApprovalAmount(ARC_PRIMARY_NETWORK.id, 5_000_000n, 5_018_687n)).toBe(5_000_000n);
    expect(getCircleForwardingApprovalTarget(ETHEREUM_SEPOLIA.id)).toBe('0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A');
    expect(getCircleForwardingApprovalAmount(ETHEREUM_SEPOLIA.id, 5_000_000n, 5_018_687n)).toBe(5_018_687n);
  });

  it('selects the current quote spender and exact route amount for both bridge routes', () => {
    const source = getOrbitNetwork(ARC_PRIMARY_NETWORK.id);
    const destination = getOrbitNetwork(ETHEREUM_SEPOLIA.id);
    if (!source || !destination) throw new Error('Expected Arc and Sepolia network fixtures');
    const fromToken = { chainId: source.id, address: source.usdc, symbol: 'USDC', name: 'Arc USDC', decimals: 6, isNative: false };
    const toToken = { chainId: destination.id, address: destination.usdc, symbol: 'USDC', name: 'Sepolia USDC', decimals: 6, isNative: false };
    const quote: BridgeQuote = {
      id: 'bridge-quote',
      provider: 'Circle',
      fromChain: { id: source.id, name: source.name },
      toChain: { id: destination.id, name: destination.name },
      fromToken,
      toToken,
      fromAmount: 5_000_000n,
      toAmount: 5_000_000n,
      toAmountMin: 5_000_000n,
      feeAmount: 0n,
      totalSourceDebit: 5_018_687n,
      selectedRoute: 'cctp',
      gasAmount: null,
      gasCosts: [],
      executionDurationSeconds: null,
      transactionTarget: source.tokenMessengerV2,
      transactionData: '0x1234',
      transactionValue: 0n,
      bridge: 'CCTP V2',
      quotedAt: Date.now(),
      raw: {},
    };

    expect(getBridgeApprovalRequest(quote, true)).toEqual({ spender: source.tokenMessengerV2, amount: 5_000_000n });
    expect(getBridgeApprovalRequest({ ...quote, selectedRoute: 'forwarding', transactionTarget: null }, true)).toEqual({
      spender: getCircleForwardingApprovalTarget(source.id),
      amount: 5_000_000n,
    });
    expect(getBridgeApprovalRequest(quote, false)).toEqual({ spender: null, amount: null });
  });

  it('keeps rejected approvals retryable and blocks approval on the wrong network', () => {
    expect(getBridgeApprovalActionState({ required: true, isReady: true, sourceNetworkReady: true, status: 'failed' })).toEqual({
      show: true,
      disabled: false,
      label: 'Retry approval',
    });
    expect(getBridgeApprovalActionState({ required: true, isReady: true, sourceNetworkReady: false, status: 'idle' }).show).toBe(false);
    expect(getBridgeApprovalActionState({ required: false, isReady: true, sourceNetworkReady: true, status: 'idle' }).show).toBe(false);
    expect(getBridgeApprovalActionState({ required: true, isReady: true, sourceNetworkReady: true, status: 'pending' }).disabled).toBe(true);
  });

  it('prevents duplicate approval requests until the first attempt settles', () => {
    const guard = createBridgeApprovalOneShotGuard();
    expect(guard.claim()).toBe(true);
    expect(guard.claim()).toBe(false);
    guard.release();
    expect(guard.claim()).toBe(true);
  });
});
