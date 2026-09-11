import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient } from 'wagmi';
import { base } from 'wagmi/chains';
import { createAaveProvider } from '../services/lending/aave';
import type { LendingPosition } from '../types/lending';

export function useLendingPositions(enabled = true) {
  const { address, chainId, isConnected } = useAccount();
  const client = usePublicClient({ chainId: base.id });
  const query = useQuery<LendingPosition>({
    queryKey: ['lending-position', address, base.id],
    queryFn: () => createAaveProvider(client!).getPosition(address!),
    enabled: Boolean(enabled && address && isConnected && chainId === base.id && client),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  return { position: query.data, isLoading: query.isLoading, isFetching: query.isFetching, isError: query.isError, error: query.error, refetch: query.refetch };
}
