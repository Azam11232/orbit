import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { createCctpProvider } from '../services/bridge/cctp';
import type { BridgeChain, BridgeQuote, BridgeToken } from '../types/bridge';

const provider = createCctpProvider();

export function isBridgeReviewable(input: { isConnected: boolean; wrongNetwork: boolean; sameNetwork: boolean; hasSourceToken: boolean; hasDestinationToken: boolean; hasQuote: boolean; hasAmount: boolean; hasAmountError: boolean; approvalRequired: boolean; simulationSucceeded: boolean; isSimulating: boolean; quoteFresh: boolean }) {
  return input.isConnected && !input.wrongNetwork && !input.sameNetwork && input.hasSourceToken && input.hasDestinationToken && input.hasQuote && input.hasAmount && !input.hasAmountError && !input.approvalRequired && input.simulationSucceeded && !input.isSimulating && input.quoteFresh;
}

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
  const sourceClient = usePublicClient({ chainId: fromChain.id });
  const simulation = useQuery({
    queryKey: ['bridge-simulation', query.data?.id, address],
    queryFn: async () => {
      if (!query.data?.transactionTarget || !query.data.transactionData || !sourceClient || !address) throw new Error('Bridge simulation is unavailable');
      await sourceClient.call({ account: address, to: query.data.transactionTarget, data: query.data.transactionData, value: query.data.transactionValue });
      return true;
    },
    enabled: Boolean(query.data && sourceClient && address),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return { quote: query.data, isLoading: query.isLoading || debouncedAmount !== amount, isFetching: query.isFetching, isError: query.isError, error: query.error, simulationError: simulation.error, isSimulating: simulation.isLoading, simulationSucceeded: simulation.data === true, refetch: query.refetch, provider: 'Circle CCTP V2' };
}
