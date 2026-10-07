import { describe, expect, it } from 'vitest';
import { getCurrentArcSwapQuote, isArcSwapQuoteReviewable } from './quoteState';

const quote = {
  estimatedOutput: { amount: '9.5' },
  stopLimit: { amount: '9.4' },
  fees: [{ amount: '0.1', token: 'EURC' }],
  expiresAt: 123,
};

describe('current Arc Swap quote state', () => {
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
});
