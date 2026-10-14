import { describe, expect, it } from 'vitest';
import { getBridgeQuoteFreshnessState, isBridgeReviewable, isManualBridgeSimulationRequired, isSameBridgeQuoteSnapshot, shouldAutoRefreshBridgeQuote, shouldFetchBridgeQuote } from './useBridgeQuote';

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
  });
});