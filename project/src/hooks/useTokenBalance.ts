import { erc20Abi, formatUnits } from 'viem';
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import type { BaseAssetConfig } from '../data/tokens';

export type TokenConfig = BaseAssetConfig & { address: Address };

export function formatTokenBalance(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

export function useTokenBalance(token: TokenConfig, address?: Address, enabled = true) {
  const result = useReadContract({
    abi: erc20Abi,
    address: token.address,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: token.chainId,
    query: { enabled: Boolean(address) && enabled },
  });

  const raw = result.data ?? 0n;
  const formatted = formatTokenBalance(raw, token.decimals);

  return {
    raw,
    formatted,
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
    refetch: result.refetch,
  };
}
