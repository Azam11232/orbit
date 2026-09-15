import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { encodeFunctionData, erc20Abi, type Address, type Hash } from 'viem';
import type { BridgeToken } from '../types/bridge';

export function useBridgeApproval(token: BridgeToken | undefined, owner: Address | undefined, spender: Address | null, amount: bigint | null) {
  const { chainId } = useAccount();
  const query = useReadContract({
    address: token?.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner && spender && token ? [owner, spender] : undefined,
    chainId: token?.chainId,
    query: { enabled: Boolean(token && chainId === token.chainId && !token.isNative && owner && spender && amount !== null && amount > 0n) },
  });
  const publicClient = usePublicClient({ chainId: token?.chainId });
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'confirmation' | 'pending' | 'confirmed' | 'failed'>('idle');
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);
  const allowance = query.data ?? 0n;
  const required = Boolean(token && !token.isNative && spender && amount !== null && amount > 0n && allowance < amount);
  const amountKey = amount?.toString();
  useEffect(() => {
    setStatus('idle');
    setHash(undefined);
    setError(null);
  }, [token?.chainId, token?.address, spender, amountKey, owner]);
  const approve = async () => {
    if (!token || chainId !== token.chainId || token.isNative || !token.address || !spender || !owner || !amount || amount <= 0n || !publicClient) return;
    if (status === 'confirmation' || status === 'pending') {
      setError(new Error('Bridge approval already in progress'));
      return;
    }
    const currentAllowance = (await query.refetch()).data ?? 0n;
    if (currentAllowance >= amount) {
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
      setStatus('confirmed');
      return;
    }
    setStatus('confirmation');
    setHash(undefined);
    setError(null);
    try {
      const gas = await publicClient.estimateGas({
        account: owner,
        to: token.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
      });
      const gasPrice = await publicClient.getGasPrice();
      const nativeBalance = await publicClient.getBalance({ address: owner });
      if (nativeBalance < gas * gasPrice) throw new Error(`Insufficient ${token.chainId === 5042002 ? 'native USDC' : 'native gas'} balance for approval`);
      const txHash = await writeContractAsync({ address: token.address, abi: erc20Abi, functionName: 'approve', args: [spender, amount], chainId: token.chainId });
      setHash(txHash);
      setStatus('pending');
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Bridge approval transaction reverted');
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
      await query.refetch();
      await queryClient.invalidateQueries({ queryKey: ['bridge-simulation'] });
      setStatus('confirmed');
    } catch (caughtError) {
      setStatus('failed');
      setError(caughtError instanceof Error ? caughtError : new Error('Bridge approval failed'));
    }
  };
  return { allowance, required, isLoading: query.isLoading, isError: query.isError, approve, status, hash, error };
}
