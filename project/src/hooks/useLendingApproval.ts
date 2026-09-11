import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { erc20Abi, type Hash } from 'viem';
import { base } from 'wagmi/chains';
import { AAVE_BASE_POOL } from '../services/lending/aave';
import type { LendingAssetConfig } from '../types/lending';

export function useLendingApproval(asset: LendingAssetConfig | undefined, amount: bigint | null, enabled = true) {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: base.id });
  const query = useReadContract({ address: asset?.underlying, abi: erc20Abi, functionName: 'allowance', args: address ? [address, AAVE_BASE_POOL] : undefined, chainId: base.id, query: { enabled: Boolean(enabled && asset && address && chainId === base.id && amount && amount > 0n) } });
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'confirmation' | 'pending' | 'confirmed' | 'failed'>('idle');
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);
  const allowance = query.data ?? 0n;
  const required = Boolean(asset && amount && amount > 0n && allowance < amount);
  const approve = async () => {
    if (!asset || !address || !client || !amount || amount <= 0n) return;
    if (status === 'confirmation' || status === 'pending') {
      setError(new Error('Approval already in progress'));
      return;
    }
    setStatus('confirmation'); setHash(undefined); setError(null);
    try { const txHash = await writeContractAsync({ address: asset.underlying, abi: erc20Abi, functionName: 'approve', args: [AAVE_BASE_POOL, amount], chainId: base.id }); setHash(txHash); setStatus('pending'); await client.waitForTransactionReceipt({ hash: txHash }); setStatus('confirmed'); await queryClient.invalidateQueries({ queryKey: query.queryKey }); }
    catch (caught) { setStatus('failed'); setError(caught instanceof Error ? caught : new Error('Approval failed')); }
  };
  return { allowance, required, isLoading: query.isLoading, isError: query.isError, status, hash, error, approve };
}
