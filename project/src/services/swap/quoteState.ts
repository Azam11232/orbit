export interface ArcSwapQuoteQueryState<T> {
  quote: T | undefined;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
}

export function getCurrentArcSwapQuote<T>(
  query: ArcSwapQuoteQueryState<T>,
  isUnavailableRoute: boolean,
): T | undefined {
  if (!query.isSuccess || query.isError || query.isFetching || isUnavailableRoute) {
    return undefined;
  }
  return query.quote;
}

export function isArcSwapQuoteReviewable<T>(
  query: ArcSwapQuoteQueryState<T>,
  isUnavailableRoute: boolean,
  quoteFresh: boolean,
): boolean {
  return quoteFresh && Boolean(getCurrentArcSwapQuote(query, isUnavailableRoute));
}
