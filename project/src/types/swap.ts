import type { Address } from 'viem';
import type { BaseAssetConfig } from '../data/tokens';

export interface SwapQuoteRequest {
  tokenIn: BaseAssetConfig;
  tokenOut: BaseAssetConfig;
  amountIn: bigint;
  walletAddress?: Address;
}

export interface SwapQuote {
  tokenIn: BaseAssetConfig;
  tokenOut: BaseAssetConfig;
  amountIn: bigint;
  amountOut: bigint;
  minimumReceived: bigint | null;
  routerAddress: Address | null;
  gas: bigint | null;
  gasPriceWei: bigint | null;
  gasUsd: number | null;
  priceImpact: number | null;
  routeLabel: string;
  routeSummary: unknown;
  quotedAt: number;
}

export interface SwapBuildRequest {
  quote: SwapQuote;
  sender: Address;
  recipient: Address;
  slippageBps: number;
  deadline: bigint;
}

export interface SwapTransaction {
  to: Address;
  data: `0x${string}`;
  value: bigint;
  routerAddress: Address;
  deadline: bigint;
  minimumReceived: bigint | null;
}

export interface SwapProvider {
  getQuote(request: SwapQuoteRequest): Promise<SwapQuote>;
  buildTransaction(request: SwapBuildRequest): Promise<SwapTransaction>;
}
