import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { base } from 'wagmi/chains';
import { createBasescanProvider, type ChainTransaction } from '../services/transactions';

const provider = createBasescanProvider();

export interface UseTransactionsResult {
  transactions: ChainTransaction[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isFetching: boolean;
}

export function useTransactions(address?: Address, enabled = true): UseTransactionsResult {
  const query = useQuery({
    queryKey: ['transactions', address, base.id],
    queryFn: async () => {
      if (!address) return [];
      return provider.fetchTransactions({ address, chainId: base.id, limit: 20 });
    },
    enabled: Boolean(address) && enabled,
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
