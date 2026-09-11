import { erc20Abi } from 'viem';
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import type { BaseAssetConfig } from '../data/tokens';

export type TokenConfig = BaseAssetConfig & { address: Address };

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
  const formatted = Number(raw) / 10 ** token.decimals;

  return {
    raw,
    formatted,
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
  };
}
