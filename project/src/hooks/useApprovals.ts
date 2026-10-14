import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient } from 'wagmi';
import { ARC_TESTNET } from '../data/networks';
import { createApprovalProvider, isSameSecurityContext, type ApprovalScanResult } from '../services/security';

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

export function useApprovals(scanOnMount = false): UseApprovalsResult {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_TESTNET.id });
  const query = useQuery({
    queryKey: ['approvals', address?.toLowerCase(), chainId],
    queryFn: () => {
      if (!address || chainId !== ARC_TESTNET.id || !publicClient) {
        throw new Error('Connect a wallet on Arc Testnet to scan approvals');
      }
      return getProvider(publicClient).scan(address);
    },
    enabled: scanOnMount && isConnected && Boolean(address) && chainId === ARC_TESTNET.id,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const data = !query.isFetching && !query.isError && query.data && isSameSecurityContext(
    { address: query.data.walletAddress, chainId: query.data.chainId },
    { address, chainId },
  ) ? query.data : undefined;

  return {
    data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
