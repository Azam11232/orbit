import { useState } from 'react';
import { useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { erc20Abi, type Address, type Hash } from 'viem';
import { base } from 'wagmi/chains';
import type { BaseAssetConfig } from '../data/tokens';

export function useSwapApproval(asset: BaseAssetConfig, owner: Address | undefined, spender: Address | null, amount: bigint | null) {
  const query = useReadContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner && spender && amount !== null ? [owner, spender] : undefined,
    chainId: base.id,
    query: { enabled: Boolean(!asset.isNative && asset.address && owner && spender && amount !== null && amount > 0n) },
  });
  const publicClient = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [approvalStatus, setApprovalStatus] = useState<'idle' | 'confirmation' | 'pending' | 'confirmed' | 'failed'>('idle');
  const [approvalHash, setApprovalHash] = useState<Hash>();
  const [approvalError, setApprovalError] = useState<Error | null>(null);
  const allowance = query.data ?? 0n;
  const approve = async () => {
    if (asset.isNative || !asset.address || !spender || !amount || amount <= 0n) return;
    if (approvalStatus === 'confirmation' || approvalStatus === 'pending') {
      setApprovalError(new Error('Approval already in progress'));
      return;
    }
    if (!publicClient || !owner) {
      setApprovalStatus('failed');
      setApprovalError(new Error('Wallet or Base RPC is unavailable'));
      return;
    }
    setApprovalStatus('confirmation');
    setApprovalHash(undefined);
    setApprovalError(null);
    try {
      const hash = await writeContractAsync({ address: asset.address, abi: erc20Abi, functionName: 'approve', args: [spender, amount], chainId: base.id });
      setApprovalHash(hash);
      setApprovalStatus('pending');
      await publicClient.waitForTransactionReceipt({ hash });
      setApprovalStatus('confirmed');
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
    } catch (caughtError) {
      setApprovalStatus('failed');
      setApprovalError(caughtError instanceof Error ? caughtError : new Error('Approval transaction failed'));
    }
  };
  return {
    allowance,
    isApprovalRequired: Boolean(!asset.isNative && spender && amount !== null && allowance < amount),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    approve,
    approvalStatus,
    approvalHash,
    approvalError,
  };
}
