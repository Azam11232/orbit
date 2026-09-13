import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import {
  createSwapKitContext,
  estimate,
  swap,
  type SwapEstimate,
  type SwapResult,
} from '@circle-fin/swap-kit';
import type { EIP1193Provider } from 'viem';
import type { ArcSwapSymbol } from '../../types/swap';

const swapContext = createSwapKitContext();

export interface ArcSwapRequest {
  provider: EIP1193Provider;
  walletAddress: `0x${string}`;
  tokenIn: ArcSwapSymbol;
  tokenOut: ArcSwapSymbol;
  amountIn: string;
  slippageBps: number;
}

export async function estimateArcSwap({
  provider,
  walletAddress,
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
}: ArcSwapRequest): Promise<SwapEstimate> {
  const adapter = await createViemAdapterFromProvider({ provider });
  return estimate(swapContext, {
    from: { adapter, chain: 'Arc_Testnet' },
    tokenIn,
    tokenOut,
    amountIn,
    to: { recipientAddress: walletAddress },
    config: { allowanceStrategy: 'approve', slippageBps },
  });
}

export async function executeArcSwap({
  provider,
  walletAddress,
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
}: ArcSwapRequest): Promise<SwapResult> {
  const adapter = await createViemAdapterFromProvider({ provider });
  return swap(swapContext, {
    from: { adapter, chain: 'Arc_Testnet' },
    tokenIn,
    tokenOut,
    amountIn,
    to: { recipientAddress: walletAddress },
    config: { allowanceStrategy: 'approve', slippageBps },
  });
}
