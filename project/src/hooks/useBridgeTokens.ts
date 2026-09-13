import { useQuery } from '@tanstack/react-query';
import { createCctpProvider } from '../services/bridge/cctp';
import type { BridgeToken } from '../types/bridge';
import { CCTP_BRIDGE_NETWORKS } from '../data/networks';

const provider = createCctpProvider();
const CHAIN_IDS = CCTP_BRIDGE_NETWORKS.map((network) => network.id);

export function useBridgeTokens() {
  const query = useQuery<BridgeToken[]>({
    queryKey: ['bridge-tokens', CHAIN_IDS],
    queryFn: () => provider.getTokens(CHAIN_IDS),
    staleTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  });
  return { tokens: query.data ?? [], isLoading: query.isLoading, isError: query.isError, error: query.error };
}
