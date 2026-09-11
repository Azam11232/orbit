import { useQuery } from '@tanstack/react-query';
import { fetchDiscoverData } from '../services/discover';

export function useDiscover() {
  const query = useQuery({
    queryKey: ['discover', 'base'],
    queryFn: fetchDiscoverData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
