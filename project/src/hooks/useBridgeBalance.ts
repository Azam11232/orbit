import { useAccount, useBalance, useReadContract } from 'wagmi';
import { erc20Abi, type Address } from 'viem';
import type { BridgeToken } from '../types/bridge';

export function useBridgeBalance(token: BridgeToken | undefined, address?: Address, enabled = true) {
  const { chainId } = useAccount();
  const isWrongNetwork = Boolean(token && chainId !== token.chainId);
  const native = useBalance({ address, chainId: token?.chainId, query: { enabled: Boolean(token?.isNative && address && enabled && !isWrongNetwork) } });
  const erc20 = useReadContract({
    address: token?.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: token?.chainId,
    query: { enabled: Boolean(token && !token.isNative && address && enabled && !isWrongNetwork) },
  });
  const raw = token?.isNative ? native.data?.value ?? 0n : erc20.data ?? 0n;
  return { raw, isLoading: native.isLoading || erc20.isLoading, isError: native.isError || erc20.isError, isWrongNetwork };
}
