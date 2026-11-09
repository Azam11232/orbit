import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient } from 'wagmi';
import { ARC_TESTNET } from '../data/networks';
import {
  createApprovalProvider,
  getPreferredApprovalScanHistoryWindow,
  isSameSecurityContext,
  type ApprovalScanHistoryWindow,
  type ApprovalScanResult,
} from '../services/security';

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
  cooldownUntil: number | null;
  refetch: () => void;
  continueScan: () => Promise<void>;
}

export function useApprovals(
  scanOnMount = false,
  historyWindowBlocks: ApprovalScanHistoryWindow = getPreferredApprovalScanHistoryWindow(),
): UseApprovalsResult {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_TESTNET.id });
  const query = useQuery({
    queryKey: ['approvals', address?.toLowerCase(), chainId, historyWindowBlocks],
    queryFn: () => {
      if (!address || chainId !== ARC_TESTNET.id || !publicClient) {
        throw new Error('Connect a wallet on Arc Testnet to scan approvals');
      }
      return getProvider(publicClient).scan(address, historyWindowBlocks);
    },
    enabled: scanOnMount && isConnected && Boolean(address) && chainId === ARC_TESTNET.id,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const data = query.data && isSameSecurityContext(
    { address: query.data.walletAddress, chainId: query.data.chainId },
    { address, chainId },
  ) ? query.data : undefined;

  return {
    data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    cooldownUntil: address && publicClient
      ? getProvider(publicClient).getCooldownUntil(address)
      : null,
    refetch: () => {
      void query.refetch();
    },
    continueScan: async () => {
      if (!address || chainId !== ARC_TESTNET.id || !publicClient) {
        throw new Error('Connect a wallet on Arc Testnet to continue scanning approvals');
      }
      const provider = getProvider(publicClient);
      const cooldownUntil = provider.getCooldownUntil(address);
      if (cooldownUntil !== null) {
        throw new Error(`Approval scan can resume at ${new Date(cooldownUntil).toLocaleTimeString()}.`);
      }
      await query.refetch();
    },
  };
}
