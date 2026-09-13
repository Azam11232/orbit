import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { arcTestnet } from 'wagmi/chains';
import { createArcProvider, type ChainTransaction } from '../services/transactions';

const arcProvider = createArcProvider();

export function isTransactionChainSupported(chainId: number): boolean {
  return chainId === arcTestnet.id;
}

export function getTransactionProviderForChain(chainId: number) {
  return chainId === arcTestnet.id ? arcProvider : undefined;
}

export interface UseTransactionsResult {
  transactions: ChainTransaction[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isFetching: boolean;
}

export function useTransactions(address?: Address, enabled = true, chainId: number = arcTestnet.id): UseTransactionsResult {
  const query = useQuery({
    queryKey: ['transactions', address, chainId],
    queryFn: async () => {
      if (!address) return [];
      const provider = getTransactionProviderForChain(chainId);
      if (!provider) throw new Error('Arc activity is only available on Arc Testnet');
      return provider.fetchTransactions({ address, chainId, limit: 20 });
    },
    enabled: Boolean(address) && enabled && isTransactionChainSupported(chainId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
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
