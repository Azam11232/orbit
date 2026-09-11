import { useReadContract } from 'wagmi';
import { erc20Abi, type Address } from 'viem';
import type { LendingAssetConfig } from '../types/lending';

export function useLendingBalance(asset: LendingAssetConfig | undefined, address?: Address, enabled = true) {
  const token = useReadContract({ address: asset?.underlying, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, chainId: 8453, query: { enabled: Boolean(enabled && asset && address) } });
  return { raw: token.data ?? 0n, isLoading: token.isLoading, isError: token.isError };
}
