import { describe, expect, it } from 'vitest';
import { ARC_PRIMARY_NETWORK, BASE_SEPOLIA, ETHEREUM_SEPOLIA, getOrbitNetwork } from '../data/networks';
import { getBridgeNativeGasRequirement, getBridgeQuoteFreshnessState, isBridgeNativeGasReady, isBridgeReviewable, isManualBridgeSimulationRequired, isSameBridgeQuoteSnapshot, isBridgeQuoteCurrent, shouldAutoRefreshBridgeQuote, shouldFetchBridgeQuote } from './useBridgeQuote';
import type { BridgeQuote } from '../types/bridge';

const walletA = '0x1111111111111111111111111111111111111111' as const;
const walletB = '0x2222222222222222222222222222222222222222' as const;
const arcQuote: BridgeQuote = {
  id: 'arc-quote',
  provider: 'Circle',
  fromChain: { id: ARC_PRIMARY_NETWORK.id, name: ARC_PRIMARY_NETWORK.name },
  toChain: { id: ETHEREUM_SEPOLIA.id, name: ETHEREUM_SEPOLIA.name },
  fromToken: { chainId: ARC_PRIMARY_NETWORK.id, address: ARC_PRIMARY_NETWORK.usdc, symbol: 'USDC', name: 'USDC', decimals: 6, isNative: false },
  toToken: { chainId: ETHEREUM_SEPOLIA.id, address: getOrbitNetwork(ETHEREUM_SEPOLIA.id)!.usdc, symbol: 'USDC', name: 'USDC', decimals: 6, isNative: false },
  recipientAddress: walletA,
  selectedRoute: 'forwarding',
  fromAmount: 1_000_000n,
  toAmount: 990_000n,
  toAmountMin: 990_000n,
  feeAmount: 10_000n,
  gasAmount: null,
  gasCosts: [],
  executionDurationSeconds: null,
  transactionTarget: null,
  transactionData: null,
  transactionValue: 0n,
  bridge: 'Circle',
  quotedAt: 1_000,
  raw: {},
};

const ready = {
  isConnected: true,
  wrongNetwork: false,
  sameNetwork: false,
  hasSourceToken: true,
  hasDestinationToken: true,
  hasQuote: true,
  hasAmount: true,
  hasAmountError: false,
  quoteFresh: true,
};

describe('route-aware bridge simulation gating', () => {
  it('requires legacy CCTP burn simulation only for the CCTP route', () => {
    expect(isManualBridgeSimulationRequired('forwarding')).toBe(false);
    expect(isManualBridgeSimulationRequired('cctp')).toBe(true);
  });

  describe('Arc native gas preflight', () => {
    it('sums the Arc source transaction estimates in native USDC and excludes approval and destination gas', () => {
      const requirement = getBridgeNativeGasRequirement({
        ...arcQuote,
        gasEstimates: [
          { step: 'approve', chainId: ARC_PRIMARY_NETWORK.id, tokenSymbol: 'USDC', decimals: 18, amount: 9n },
          { step: 'burn', chainId: ARC_PRIMARY_NETWORK.id, tokenSymbol: 'USDC', decimals: 18, amount: 2_000_000_000_000_000n },
          { step: 'mint', chainId: ETHEREUM_SEPOLIA.id, tokenSymbol: 'ETH', decimals: 18, amount: 7n },
        ],
      }, ARC_PRIMARY_NETWORK.id);

      expect(requirement).toEqual({ amount: 2_000_000_000_000_000n, tokenSymbol: 'USDC', decimals: 18 });
    });

    it('includes the separate native gas estimate when a USDC approval is required', () => {
      const approval = {
        ...arcQuote,
        gasEstimates: [
          { step: 'approve', chainId: ARC_PRIMARY_NETWORK.id, tokenSymbol: 'USDC', decimals: 18, amount: 9n },
          { step: 'burn', chainId: ARC_PRIMARY_NETWORK.id, tokenSymbol: 'USDC', decimals: 18, amount: 2_000_000_000_000_000n },
        ],
      };

      expect(getBridgeNativeGasRequirement(approval, ARC_PRIMARY_NETWORK.id, true)).toEqual({
        amount: 2_000_000_000_000_009n,
        tokenSymbol: 'USDC',
        decimals: 18,
      });
      expect(getBridgeNativeGasRequirement({
        ...approval,
        gasEstimates: approval.gasEstimates.filter((gas) => gas.step !== 'approve'),
      }, ARC_PRIMARY_NETWORK.id, true)).toMatchObject({ error: expect.stringContaining('approval gas estimate') });
    });

    it('reports absent or invalid gas estimates instead of inventing a fee', () => {
      expect(getBridgeNativeGasRequirement(arcQuote, ARC_PRIMARY_NETWORK.id)).toMatchObject({ error: expect.stringContaining('did not provide') });
      expect(getBridgeNativeGasRequirement({
        ...arcQuote,
        gasEstimates: [{ step: 'burn', chainId: ARC_PRIMARY_NETWORK.id, tokenSymbol: 'ETH', decimals: 18, amount: 1n }],
      }, ARC_PRIMARY_NETWORK.id)).toMatchObject({ error: expect.stringContaining('invalid') });
    });

    it('requires a current quote, checked balance, and enough native gas', () => {
      const requirement = { amount: 10n, tokenSymbol: 'USDC', decimals: 18 };
      const ready = {
        applicable: true,
        quoteCurrent: true,
        loading: false,
        balance: 10n,
        error: false,
        requirement,
      };
      expect(isBridgeNativeGasReady(ready)).toBe(true);
      expect(isBridgeNativeGasReady({ ...ready, balance: 9n })).toBe(false);
      expect(isBridgeNativeGasReady({ ...ready, quoteCurrent: false })).toBe(false);
      expect(isBridgeNativeGasReady({ ...ready, loading: true })).toBe(false);
      expect(isBridgeNativeGasReady({ ...ready, error: true })).toBe(false);
      expect(isBridgeNativeGasReady({ ...ready, requirement: { error: 'Estimate unavailable' } })).toBe(false);
      expect(isBridgeNativeGasReady({ ...ready, applicable: false, balance: null })).toBe(true);
    });
  });
});

describe('bridge review readiness', () => {
  it('allows review for a valid route and amount', () => {
    expect(isBridgeReviewable(ready)).toBe(true);
    expect(isBridgeReviewable({ ...ready, sameNetwork: true })).toBe(false);
    expect(isBridgeReviewable({ ...ready, feeValid: false })).toBe(false);
  });

  it.each([
    ['quote is stale', { quoteFresh: false }],
    ['quote is loading or missing', { hasQuote: false }],
    ['quote has an invalid fee', { feeValid: false }],
    ['wallet is disconnected', { isConnected: false }],
  ])('disables Review Bridge when %s', (_reason, overrides) => {
    expect(isBridgeReviewable({ ...ready, ...overrides })).toBe(false);
  });

  it('marks an expired quote stale and blocks review', () => {
    expect(getBridgeQuoteFreshnessState({ hasQuote: true, quoteCurrent: false, isLoading: false, isFetching: false, isError: false })).toBe('stale');
    expect(isBridgeReviewable({ ...ready, quoteFresh: false })).toBe(false);
  });

  it('keeps an old quote marked stale while the amount debounce is pending', () => {
    expect(getBridgeQuoteFreshnessState({ hasQuote: true, quoteCurrent: false, isLoading: true, isFetching: false, isError: false })).toBe('stale');
  });

  it('marks a refresh in progress and blocks review until it completes', () => {
    expect(getBridgeQuoteFreshnessState({ hasQuote: true, quoteCurrent: false, isLoading: false, isFetching: true, isError: false })).toBe('refreshing');
    expect(isBridgeReviewable({ ...ready, hasQuote: false })).toBe(false);
  });

  it('keeps a failed refresh distinct from a fresh quote', () => {
    expect(getBridgeQuoteFreshnessState({ hasQuote: true, quoteCurrent: false, isLoading: false, isFetching: false, isError: true })).toBe('refresh-failed');
    expect(isBridgeReviewable({ ...ready, quoteFresh: false })).toBe(false);
  });

  it('allows a quote to be reviewed only after it is current', () => {
    expect(getBridgeQuoteFreshnessState({ hasQuote: true, quoteCurrent: true, isLoading: false, isFetching: false, isError: false })).toBe('fresh');
    expect(isBridgeReviewable(ready)).toBe(true);
  });

  describe('bridge quote request gating', () => {
    const currentQuoteInput = {
      executionStarted: false,
      amount: 1_000_000n,
      debouncedAmount: 1_000_000n,
      hasSourceToken: true,
      hasDestinationToken: true,
      hasAddress: true,
      sameNetwork: false,
    };

    it('requests only the settled current amount while no execution is active', () => {
      expect(shouldFetchBridgeQuote(currentQuoteInput)).toBe(true);
      expect(shouldFetchBridgeQuote({ ...currentQuoteInput, debouncedAmount: null })).toBe(false);
      expect(shouldFetchBridgeQuote({ ...currentQuoteInput, debouncedAmount: 999_999n })).toBe(false);
    });

    it('does not refetch a quote after amount reset or while tracking an execution', () => {
      expect(shouldFetchBridgeQuote({ ...currentQuoteInput, amount: null, debouncedAmount: 1_000_000n })).toBe(false);
      expect(shouldFetchBridgeQuote({ ...currentQuoteInput, executionStarted: true })).toBe(false);
    });

    it('auto-refreshes only an expired quote for the active current request', () => {
      expect(shouldAutoRefreshBridgeQuote({ quoteExpired: true, queryEnabled: true, executionStarted: false, isFetching: false })).toBe(true);
      expect(shouldAutoRefreshBridgeQuote({ quoteExpired: false, queryEnabled: true, executionStarted: false, isFetching: false })).toBe(false);
      expect(shouldAutoRefreshBridgeQuote({ quoteExpired: true, queryEnabled: false, executionStarted: false, isFetching: false })).toBe(false);
      expect(shouldAutoRefreshBridgeQuote({ quoteExpired: true, queryEnabled: true, executionStarted: true, isFetching: false })).toBe(false);
      expect(shouldAutoRefreshBridgeQuote({ quoteExpired: true, queryEnabled: true, executionStarted: false, isFetching: true })).toBe(false);
    });

    it('invalidates a reviewed quote when route, freshness timestamp, or recipient changes', () => {
      const baseSnapshot = {
        id: 'quote-1',
        quotedAt: 1_000,
        selectedRoute: 'forwarding' as const,
        fromAmount: 1_000_000n,
        toAmount: 990_000n,
        toAmountMin: 990_000n,
        feeAmount: 10_000n,
        forwardingFeeAmount: 10_000n,
        protocolFeeAmount: 0n,
        fromChain: { id: 1, name: 'Source' },
        toChain: { id: 2, name: 'Destination' },
        fromToken: { chainId: 1, address: '0x1111111111111111111111111111111111111111' as `0x${string}`, symbol: 'USDC', name: 'USDC', decimals: 6, isNative: false },
        toToken: { chainId: 2, address: '0x2222222222222222222222222222222222222222' as `0x${string}`, symbol: 'USDC', name: 'USDC', decimals: 6, isNative: false },
        recipientAddress: '0x3333333333333333333333333333333333333333' as `0x${string}`,
      };
      expect(isSameBridgeQuoteSnapshot(baseSnapshot, baseSnapshot)).toBe(true);
      expect(isSameBridgeQuoteSnapshot({ ...baseSnapshot, selectedRoute: 'cctp' }, baseSnapshot)).toBe(false);
      expect(isSameBridgeQuoteSnapshot({ ...baseSnapshot, quotedAt: 1_001 }, baseSnapshot)).toBe(false);
      expect(isSameBridgeQuoteSnapshot({ ...baseSnapshot, recipientAddress: '0x4444444444444444444444444444444444444444' }, baseSnapshot)).toBe(false);
    });

    it('marks a quote stale after wallet, route, amount, or network changes', () => {
      const currentQuote = { ...arcQuote, quotedAt: 1_000 };
      const currentInput = {
        quote: currentQuote,
        sourceChainId: ARC_PRIMARY_NETWORK.id,
        destinationChainId: ETHEREUM_SEPOLIA.id,
        sourceToken: arcQuote.fromToken,
        destinationToken: arcQuote.toToken,
        recipientAddress: walletA,
        amount: arcQuote.fromAmount,
        selectedRoute: 'forwarding' as const,
        now: 1_001,
      };
      expect(isBridgeQuoteCurrent(currentInput)).toBe(true);
      expect(isBridgeQuoteCurrent({ ...currentInput, recipientAddress: walletB })).toBe(false);
      expect(isBridgeQuoteCurrent({ ...currentInput, selectedRoute: 'cctp' })).toBe(false);
      expect(isBridgeQuoteCurrent({ ...currentInput, amount: arcQuote.fromAmount + 1n })).toBe(false);
      expect(isBridgeQuoteCurrent({ ...currentInput, destinationChainId: BASE_SEPOLIA.id })).toBe(false);
    });
  });
});