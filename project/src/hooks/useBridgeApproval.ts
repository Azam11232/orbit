import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { erc20Abi, type Address, type Hash } from 'viem';
import type { BridgeToken } from '../types/bridge';

export function useBridgeApproval(token: BridgeToken | undefined, owner: Address | undefined, spender: Address | null, amount: bigint | null) {
  const query = useReadContract({ address: token?.address, abi: erc20Abi, functionName: 'allowance', args: owner && spender ? [owner, spender] : undefined, chainId: token?.chainId, query: { enabled: Boolean(token && !token.isNative && owner && spender && amount && amount > 0n) } });
  const publicClient = usePublicClient({ chainId: token?.chainId ?? base.id });
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'confirmation' | 'pending' | 'confirmed' | 'failed'>('idle');
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);
  const allowance = query.data ?? 0n;
  const required = Boolean(token && !token.isNative && spender && amount !== null && amount > 0n && allowance < amount);
  const approve = async () => {
    if (!token || token.isNative || !token.address || !spender || !owner || !amount || amount <= 0n || !publicClient) return;
    if (status === 'confirmation' || status === 'pending') {
      setError(new Error('Bridge approval already in progress'));
      return;
    }
    setStatus('confirmation'); setHash(undefined); setError(null);
    try {
      const txHash = await writeContractAsync({ address: token.address, abi: erc20Abi, functionName: 'approve', args: [spender, amount], chainId: token.chainId });
      setHash(txHash); setStatus('pending'); await publicClient.waitForTransactionReceipt({ hash: txHash }); setStatus('confirmed'); await queryClient.invalidateQueries({ queryKey: query.queryKey });
    } catch (caughtError) { setStatus('failed'); setError(caughtError instanceof Error ? caughtError : new Error('Bridge approval failed')); }
  };
  return { allowance, required, isLoading: query.isLoading, isError: query.isError, approve, status, hash, error };
}
