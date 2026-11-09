export const ARC_SWAP_QUOTE_MAX_AGE_MS = 30_000;

export interface ArcSwapDirection<T extends string = string> {
  tokenIn: T;
  tokenOut: T;
}

export function toggleArcSwapDirection<T extends string>(
  direction: ArcSwapDirection<T>,
): ArcSwapDirection<T> {
  return { tokenIn: direction.tokenOut, tokenOut: direction.tokenIn };
}

export interface ArcSwapQuoteQueryKeyInput {
  connectorId?: string;
  address?: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps: number;
}

export function createArcSwapQuoteQueryKey({
  connectorId,
  address,
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
}: ArcSwapQuoteQueryKeyInput) {
  return ['arc-swap-quote', connectorId, address, tokenIn, tokenOut, amountIn, slippageBps] as const;
}

export interface ArcSwapQuoteQueryState<T> {
  quote: T | undefined;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
}

export function isArcSwapQuoteFresh(dataUpdatedAt: number, now = Date.now()): boolean {
  return Number.isFinite(dataUpdatedAt) &&
    dataUpdatedAt > 0 &&
    now < dataUpdatedAt + ARC_SWAP_QUOTE_MAX_AGE_MS;
}

export class ArcSwapQuoteExpiredError extends Error {
  constructor() {
    super('Swap quote expired before transaction submission. Request a fresh quote.');
    this.name = 'ArcSwapQuoteExpiredError';
  }
}

export function assertArcSwapQuoteFresh(dataUpdatedAt: number, now = Date.now()): void {
  if (!isArcSwapQuoteFresh(dataUpdatedAt, now)) throw new ArcSwapQuoteExpiredError();
}

export interface ArcSwapQuoteRequestIdentity {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  chainIn?: string;
  chainOut?: string;
  fromAddress?: string;
  toAddress?: string;
}

export interface ArcSwapQuoteIdentity {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  chainIn?: string;
  chainOut?: string;
  fromAddress?: string;
  toAddress?: string;
}

export function matchesArcSwapQuoteRequest(quote: ArcSwapQuoteIdentity, request: ArcSwapQuoteRequestIdentity) {
  return quote.tokenIn === request.tokenIn &&
    quote.tokenOut === request.tokenOut &&
    quote.amountIn === request.amountIn &&
    (request.chainIn === undefined || quote.chainIn === request.chainIn) &&
    (request.chainOut === undefined || quote.chainOut === request.chainOut) &&
    (request.fromAddress === undefined || quote.fromAddress?.toLowerCase() === request.fromAddress.toLowerCase()) &&
    (request.toAddress === undefined || quote.toAddress?.toLowerCase() === request.toAddress.toLowerCase());
}

export function getCurrentArcSwapQuote<T>(
  query: ArcSwapQuoteQueryState<T>,
  isUnavailableRoute: boolean,
  matchesCurrentInput: (quote: T) => boolean = () => true,
): T | undefined {
  if (!query.isSuccess || query.isError || query.isFetching || isUnavailableRoute || !query.quote || !matchesCurrentInput(query.quote)) {
    return undefined;
  }
  return query.quote;
}

export function isArcSwapQuoteReviewable<T>(
  query: ArcSwapQuoteQueryState<T>,
  isUnavailableRoute: boolean,
  quoteFresh: boolean,
  matchesCurrentRequest: (quote: T) => boolean = () => true,
): boolean {
  return quoteFresh && Boolean(getCurrentArcSwapQuote(query, isUnavailableRoute, matchesCurrentRequest));
}

export function canReviewArcSwap<T>(input: {
  query: ArcSwapQuoteQueryState<T>;
  isUnavailableRoute: boolean;
  quoteFresh: boolean;
  matchesCurrentRequest: (quote: T) => boolean;
  isConnected: boolean;
  isArcTestnet: boolean;
  hasProvider: boolean;
  hasValidAmount: boolean;
}): boolean {
  return input.isConnected &&
    input.isArcTestnet &&
    input.hasProvider &&
    input.hasValidAmount &&
    isArcSwapQuoteReviewable(
      input.query,
      input.isUnavailableRoute,
      input.quoteFresh,
      input.matchesCurrentRequest,
    );
}

export function canSubmitArcSwapQuote<T>(
  query: ArcSwapQuoteQueryState<T>,
  isUnavailableRoute: boolean,
  quoteFresh: boolean,
  matchesCurrentRequest: (quote: T) => boolean = () => true,
): boolean {
  return isArcSwapQuoteReviewable(query, isUnavailableRoute, quoteFresh, matchesCurrentRequest);
}

export function isArcSwapReviewButtonDisabled(
  canReview: boolean,
  canStartNewSwap: boolean,
  swapLocked: boolean,
  hasTransactionHash: boolean,
): boolean {
  return !canStartNewSwap && (!canReview || swapLocked || hasTransactionHash);
}
