import { useQuery } from '@tanstack/react-query';
import { createPriceProvider, type PriceAssetConfig } from '../services/prices';

const provider = createPriceProvider();

export interface UsePricesResult {
  prices: Record<string, number>;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export function usePrices(assets: PriceAssetConfig[]): UsePricesResult {
  const query = useQuery({
    queryKey: ['prices', assets.map((asset) => asset.symbol)],
    queryFn: () => provider.fetchPrices(assets),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    prices: query.data ?? {},
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
