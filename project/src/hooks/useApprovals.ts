import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient } from 'wagmi';
import { arcTestnet } from 'wagmi/chains';
import { createApprovalProvider, type ApprovalScanResult } from '../services/security';

const providerCache = new WeakMap<object, ReturnType<typeof createApprovalProvider>>();

function getProvider(client: NonNullable<ReturnType<typeof usePublicClient>>) {
  const cached = providerCache.get(client);
  if (cached) return cached;
  const provider = createApprovalProvider(client);
  providerCache.set(client, provider);
  return provider;
}

export interface UseApprovalsResult {
  data: ApprovalScanResult | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useApprovals(): UseApprovalsResult {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const query = useQuery({
    queryKey: ['approvals', address, arcTestnet.id],
    queryFn: () => {
      if (!address || !publicClient) throw new Error('Arc Testnet RPC is unavailable');
      return getProvider(publicClient).scan(address);
    },
    enabled: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
