import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { createLifiProvider } from '../services/bridge/lifi';
import type { BridgeChain, BridgeQuote, BridgeToken } from '../types/bridge';

const provider = createLifiProvider();

export function useBridgeQuote(fromChain: BridgeChain, toChain: BridgeChain, fromToken: BridgeToken | undefined, toToken: BridgeToken | undefined, amount: bigint | null, address?: Address, slippage = 0.005) {
  const [debouncedAmount, setDebouncedAmount] = useState<bigint | null>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedAmount(amount), 350);
    return () => window.clearTimeout(timeout);
  }, [amount]);
  const query = useQuery<BridgeQuote>({
    queryKey: ['bridge-quote', fromChain.id, toChain.id, fromToken?.address, toToken?.address, debouncedAmount?.toString(), address, slippage],
    queryFn: () => provider.getQuote({ fromChain, toChain, fromToken: fromToken as BridgeToken, toToken: toToken as BridgeToken, fromAmount: debouncedAmount as bigint, fromAddress: address as Address, toAddress: address as Address, slippage }),
    enabled: Boolean(fromToken && toToken && address && debouncedAmount && debouncedAmount > 0n && fromChain.id !== toChain.id),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  return { quote: query.data, isLoading: query.isLoading || debouncedAmount !== amount, isFetching: query.isFetching, isError: query.isError, error: query.error, refetch: query.refetch, provider: 'LI.FI' };
}
