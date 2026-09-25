import { useQuery } from '@tanstack/react-query';
import { createCctpProvider } from '../services/bridge/cctp';
import type { BridgeQuote, BridgeStatus } from '../types/bridge';

const provider = createCctpProvider();

export function isBridgeStatusPollingEnabled(selectedRoute: BridgeQuote['selectedRoute'], enabled = true) {
  return enabled && selectedRoute !== 'forwarding';
}

export function useBridgeStatus(quote: BridgeQuote | undefined, sourceHash: string | undefined, enabled = true) {
  const query = useQuery<BridgeStatus>({
    queryKey: ['bridge-status', quote?.id, sourceHash],
    queryFn: () => provider.getStatus(quote as BridgeQuote, sourceHash as string),
    enabled: Boolean(isBridgeStatusPollingEnabled(quote?.selectedRoute, enabled) && quote && sourceHash),
    refetchInterval: (current) => current.state.data?.status === 'DONE' || current.state.data?.status === 'FAILED' ? false : 3_000,
    refetchOnWindowFocus: false,
  });
  return { status: query.data, isLoading: query.isLoading, isError: query.isError, error: query.error };
}
