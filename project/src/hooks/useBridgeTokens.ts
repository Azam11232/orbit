import { useQuery } from '@tanstack/react-query';
import { createLifiProvider } from '../services/bridge/lifi';
import type { BridgeToken } from '../types/bridge';

const provider = createLifiProvider();
const CHAIN_IDS = [8453, 1, 42161, 10];

export function useBridgeTokens() {
  const query = useQuery<BridgeToken[]>({
    queryKey: ['bridge-tokens', CHAIN_IDS],
    queryFn: () => provider.getTokens(CHAIN_IDS),
    staleTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  });
  return { tokens: query.data ?? [], isLoading: query.isLoading, isError: query.isError, error: query.error };
}
