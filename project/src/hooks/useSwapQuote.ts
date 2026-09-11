import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { createKyberSwapProvider } from '../services/swap/kyberswap';
import type { SwapQuote } from '../types/swap';
import type { BaseAssetConfig } from '../data/tokens';

const provider = createKyberSwapProvider();

export function useSwapQuote(tokenIn: BaseAssetConfig, tokenOut: BaseAssetConfig, amountIn: bigint | null, walletAddress?: Address) {
  const [debouncedAmount, setDebouncedAmount] = useState<bigint | null>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedAmount(amountIn), 350);
    return () => window.clearTimeout(timeout);
  }, [amountIn]);
  const query = useQuery<SwapQuote>({
    queryKey: ['swap-quote', tokenIn.symbol, tokenOut.symbol, debouncedAmount?.toString(), walletAddress],
    queryFn: () => provider.getQuote({ tokenIn, tokenOut, amountIn: debouncedAmount as bigint, walletAddress }),
    enabled: Boolean(debouncedAmount && debouncedAmount > 0n && tokenIn.symbol !== tokenOut.symbol),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });
  return { quote: query.data, isLoading: query.isLoading || debouncedAmount !== amountIn, isFetching: query.isFetching, isError: query.isError, error: query.error, refetch: query.refetch, provider: 'KyberSwap' };
}
