import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { arcTestnet, base } from 'wagmi/chains';
import { createArcProvider, createBasescanProvider, type ChainTransaction } from '../services/transactions';

const arcProvider = createArcProvider();
const baseProvider = createBasescanProvider();

export function isTransactionChainSupported(chainId: number): boolean {
  return chainId === arcTestnet.id || chainId === base.id;
}

export function getTransactionProviderForChain(chainId: number) {
  if (chainId === arcTestnet.id) return arcProvider;
  if (chainId === base.id) return baseProvider;
  return undefined;
}

export interface UseTransactionsResult {
  transactions: ChainTransaction[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isFetching: boolean;
}

export function useTransactions(
  address?: Address,
  enabled = true,
  chainId: number = arcTestnet.id,
  fetchAllPages = false,
): UseTransactionsResult {
  const shouldFetchAllPages = fetchAllPages && chainId === arcTestnet.id;
  const query = useQuery({
    queryKey: ['transactions', address, chainId, shouldFetchAllPages],
    queryFn: async () => {
      if (!address) return [];
      const provider = getTransactionProviderForChain(chainId);
      if (!provider) throw new Error('Activity is not available on this network');
      return provider.fetchTransactions({ address, chainId, limit: 20, fetchAllPages: shouldFetchAllPages });
    },
    enabled: Boolean(address) && enabled && isTransactionChainSupported(chainId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData, previousQuery) =>
      previousQuery && previousQuery.queryKey[1] === address && previousQuery.queryKey[2] === chainId
        ? previousData
        : undefined,
  });

  return {
    transactions: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => query.refetch(),
    isFetching: query.isFetching,
  };
}
