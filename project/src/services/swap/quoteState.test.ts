import { describe, expect, it } from 'vitest';
import { ARC_SWAP_QUOTE_MAX_AGE_MS, ArcSwapQuoteExpiredError, assertArcSwapQuoteFresh, canReviewArcSwap, canSubmitArcSwapQuote, createArcSwapQuoteQueryKey, getCurrentArcSwapQuote, isArcSwapQuoteFresh, isArcSwapQuoteReviewable, isArcSwapReviewButtonDisabled, matchesArcSwapQuoteRequest, toggleArcSwapDirection } from './quoteState';

const quote = {
  amountIn: '10',
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  chainIn: 'Arc_Testnet',
  chainOut: 'Arc_Testnet',
  fromAddress: '0x1111111111111111111111111111111111111111',
  toAddress: '0x1111111111111111111111111111111111111111',
  estimatedOutput: { amount: '9.5' },
  stopLimit: { amount: '9.4' },
  fees: [{ amount: '0.1', token: 'EURC' }],
  expiresAt: 123,
};

describe('current Arc Swap quote state', () => {
  it('switches USDC → EURC to EURC → USDC and back without exposing the previous direction quote', () => {
    const initial = { tokenIn: 'USDC', tokenOut: 'EURC' } as const;
    const initialKey = createArcSwapQuoteQueryKey({
      connectorId: 'wallet',
      address: quote.fromAddress,
      ...initial,
      amountIn: quote.amountIn,
      slippageBps: 50,
    });
    const reverse = toggleArcSwapDirection(initial);
    const reverseKey = createArcSwapQuoteQueryKey({
      connectorId: 'wallet',
      address: quote.fromAddress,
      ...reverse,
      amountIn: quote.amountIn,
      slippageBps: 50,
    });

    expect(reverse).toEqual({ tokenIn: 'EURC', tokenOut: 'USDC' });
    expect(reverseKey).not.toEqual(initialKey);
    expect(getCurrentArcSwapQuote(
      { quote, isSuccess: true, isError: false, isFetching: false },
      false,
      (candidate) => matchesArcSwapQuoteRequest(candidate, {
        ...reverse,
        amountIn: quote.amountIn,
      }),
    )).toBeUndefined();

    const switchedBack = toggleArcSwapDirection(reverse);
    const switchedBackKey = createArcSwapQuoteQueryKey({
      connectorId: 'wallet',
      address: quote.fromAddress,
      ...switchedBack,
      amountIn: quote.amountIn,
      slippageBps: 50,
    });
    expect(switchedBack).toEqual(initial);
    expect(switchedBackKey).toEqual(initialKey);
    expect(getCurrentArcSwapQuote(
      { quote, isSuccess: true, isError: false, isFetching: false },
      false,
      (candidate) => matchesArcSwapQuoteRequest(candidate, {
        ...switchedBack,
        amountIn: quote.amountIn,
      }),
    )).toBe(quote);
  });

  it('keeps a quote fresh before 30 seconds but expires it at the exact boundary', () => {
    const updatedAt = 50_000;

    expect(isArcSwapQuoteFresh(updatedAt, updatedAt + ARC_SWAP_QUOTE_MAX_AGE_MS - 1)).toBe(true);
    expect(isArcSwapQuoteFresh(updatedAt, updatedAt + ARC_SWAP_QUOTE_MAX_AGE_MS)).toBe(false);
  });

  it('blocks submission when a reviewed quote expires at the exact boundary', () => {
    const updatedAt = 50_000;
    const reviewWasEnabled = isArcSwapQuoteReviewable({
      quote,
      isSuccess: true,
      isError: false,
      isFetching: false,
    }, false, true);

    expect(reviewWasEnabled).toBe(true);
    expect(() => assertArcSwapQuoteFresh(updatedAt, updatedAt + ARC_SWAP_QUOTE_MAX_AGE_MS))
      .toThrow(ArcSwapQuoteExpiredError);
  });

  it('allows a newly updated quote while the prior quote is expired', () => {
    const now = 90_000;
    const oldUpdatedAt = now - ARC_SWAP_QUOTE_MAX_AGE_MS;
    const freshUpdatedAt = now;

    expect(isArcSwapQuoteFresh(oldUpdatedAt, now)).toBe(false);
    expect(isArcSwapQuoteFresh(freshUpdatedAt, now)).toBe(true);
  });

  it('makes a successful, settled quote available for review', () => {
    const query = {
      quote,
      isSuccess: true,
      isError: false,
      isFetching: false,
    };
    expect(getCurrentArcSwapQuote(query, false)).toBe(quote);
    expect(isArcSwapQuoteReviewable(query, false, true)).toBe(true);
  });

  it.each([
    ['valid quote', { quote, isSuccess: true, isError: false, isFetching: false }, false, true, true],
    ['rejected quote', { quote, isSuccess: false, isError: true, isFetching: false }, false, false, false],
    ['unsupported route', { quote, isSuccess: false, isError: true, isFetching: false }, true, false, false],
    ['expired quote', { quote, isSuccess: true, isError: false, isFetching: false }, false, false, false],
  ])('controls Review and submit for a %s', (_label, query, unavailableRoute, fresh, expected) => {
    const canReview = canReviewArcSwap({
      query,
      isUnavailableRoute: unavailableRoute,
      quoteFresh: fresh,
      matchesCurrentRequest: (candidate) => candidate === quote,
      isConnected: true,
      isArcTestnet: true,
      hasProvider: true,
      hasValidAmount: true,
    });

    expect(canReview).toBe(expected);
    expect(canSubmitArcSwapQuote(query, unavailableRoute, fresh, (candidate) => candidate === quote)).toBe(expected);
  });

  it.each([
    ['USDC', 'EURC'],
    ['EURC', 'USDC'],
  ])('keeps Review and submit disabled for a rejected %s → %s quote', () => {
    const rejectedQuery = {
      quote,
      isSuccess: false,
      isError: true,
      isFetching: false,
    };

    expect(canReviewArcSwap({
      query: rejectedQuery,
      isUnavailableRoute: false,
      quoteFresh: false,
      matchesCurrentRequest: () => true,
      isConnected: true,
      isArcTestnet: true,
      hasProvider: true,
      hasValidAmount: true,
    })).toBe(false);
    expect(canSubmitArcSwapQuote(rejectedQuery, false, false)).toBe(false);
    expect(getCurrentArcSwapQuote(rejectedQuery, false)).toBeUndefined();
  });

  it('disables Review when wallet, network, provider, or amount prerequisites are missing', () => {
    const query = { quote, isSuccess: true, isError: false, isFetching: false };
    const base = {
      query,
      isUnavailableRoute: false,
      quoteFresh: true,
      matchesCurrentRequest: () => true,
      isConnected: true,
      isArcTestnet: true,
      hasProvider: true,
      hasValidAmount: true,
    };

    expect(canReviewArcSwap({ ...base, isConnected: false })).toBe(false);
    expect(canReviewArcSwap({ ...base, isArcTestnet: false })).toBe(false);
    expect(canReviewArcSwap({ ...base, hasProvider: false })).toBe(false);
    expect(canReviewArcSwap({ ...base, hasValidAmount: false })).toBe(false);
  });

  it('drives the native Review button disabled state for blocked quotes and allows a new swap after dismissal', () => {
    expect(isArcSwapReviewButtonDisabled(false, false, false, false)).toBe(true);
    expect(isArcSwapReviewButtonDisabled(false, true, false, false)).toBe(false);
    expect(isArcSwapReviewButtonDisabled(true, false, true, false)).toBe(true);
    expect(isArcSwapReviewButtonDisabled(true, false, false, true)).toBe(true);
    expect(isArcSwapReviewButtonDisabled(true, false, false, false)).toBe(false);
  });

  it('hides cached quote details after a later generic quote error', () => {
    const query = {
      quote,
      isSuccess: false,
      isError: true,
      isFetching: false,
    };
    const currentQuote = getCurrentArcSwapQuote(query, false);
    expect(currentQuote).toBeUndefined();
    expect(isArcSwapQuoteReviewable(query, false, true)).toBe(false);
    expect(currentQuote?.estimatedOutput.amount).toBeUndefined();
    expect(currentQuote?.stopLimit.amount).toBeUndefined();
    expect(currentQuote?.fees).toBeUndefined();
    expect(currentQuote?.expiresAt).toBeUndefined();
  });

  it('hides cached quote details while refetching', () => {
    const query = {
      quote,
      isSuccess: true,
      isError: false,
      isFetching: true,
    };
    expect(getCurrentArcSwapQuote(query, false)).toBeUndefined();
    expect(isArcSwapQuoteReviewable(query, false, true)).toBe(false);
  });

  it('keeps unsupported routes unavailable even if cached data exists', () => {
    const query = {
      quote,
      isSuccess: false,
      isError: true,
      isFetching: false,
    };
    expect(getCurrentArcSwapQuote(query, true)).toBeUndefined();
    expect(isArcSwapQuoteReviewable(query, true, true)).toBe(false);
  });

  it('does not expose a quote before a successful query', () => {
    expect(getCurrentArcSwapQuote({
      quote: undefined,
      isSuccess: false,
      isError: false,
      isFetching: false,
    }, false)).toBeUndefined();
  });

  it('hides a settled cached quote when it belongs to the previous input amount', () => {
    const query = {
      quote,
      isSuccess: true,
      isError: false,
      isFetching: false,
    };

    expect(getCurrentArcSwapQuote(query, false, (currentQuote) => matchesArcSwapQuoteRequest(currentQuote, {
      tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '11',
    }))).toBeUndefined();
    expect(getCurrentArcSwapQuote(query, false, (currentQuote) => matchesArcSwapQuoteRequest(currentQuote, {
      tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '10',
    }))).toBe(quote);
  });

  it.each([
    ['USDC', 'EURC', '1'],
    ['USDC', 'EURC', '125.000001'],
    ['EURC', 'USDC', '0.25'],
    ['EURC', 'USDC', '9999.99'],
  ])('matches only the exact SDK quote request for %s → %s amount %s', (tokenIn, tokenOut, amountIn) => {
    const request = { tokenIn, tokenOut, amountIn, chainIn: 'Arc_Testnet', chainOut: 'Arc_Testnet', fromAddress: quote.fromAddress, toAddress: quote.toAddress };
    expect(matchesArcSwapQuoteRequest({ ...quote, tokenIn, tokenOut, amountIn }, request)).toBe(true);
    expect(matchesArcSwapQuoteRequest({ ...quote, tokenIn, tokenOut, amountIn: `${amountIn}0` }, request)).toBe(false);
  });

});
