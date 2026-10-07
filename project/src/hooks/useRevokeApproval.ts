import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { arcTestnet } from 'wagmi/chains';
import { erc20Abi, type Hash } from 'viem';
import type { ApprovalScanResult, TokenApproval } from '../services/security';

export type RevokeStatus = 'idle' | 'pending' | 'success' | 'error';

export interface UseRevokeApprovalResult {
  revoke: (approval: TokenApproval) => Promise<void>;
  activeApprovalId: string | null;
  status: RevokeStatus;
  transactionHash: Hash | undefined;
  error: Error | null;
}

export function useRevokeApproval(): UseRevokeApprovalResult {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [activeApprovalId, setActiveApprovalId] = useState<string | null>(null);
  const [status, setStatus] = useState<RevokeStatus>('idle');
  const [transactionHash, setTransactionHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);

  const revoke = async (approval: TokenApproval) => {
    if (!address || chainId !== arcTestnet.id || !publicClient) {
      setError(new Error('Connect your wallet on Arc Testnet to revoke an approval'));
      setStatus('error');
      return;
    }
    if (status === 'pending') {
      setError(new Error('Another approval revoke is already in progress'));
      return;
    }
    if (!approval.token.address || !approval.spenderAddress) {
      setError(new Error('Approval metadata is missing or invalid'));
      setStatus('error');
      return;
    }

    setActiveApprovalId(approval.id);
    setStatus('pending');
    setTransactionHash(undefined);
    setError(null);

    try {
      const hash = await writeContractAsync({
        address: approval.token.address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [approval.spenderAddress, 0n],
        chainId: arcTestnet.id,
      });
      setTransactionHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Approval revoke transaction reverted');
      setStatus('success');
      queryClient.setQueryData<ApprovalScanResult>(['approvals', address, arcTestnet.id], (current) => current
        ? { ...current, approvals: current.approvals.filter((entry) => entry.id !== approval.id) }
        : current);
      await queryClient.invalidateQueries({ queryKey: ['approvals', address, arcTestnet.id] });
    } catch (caughtError) {
      setStatus('error');
      setError(caughtError instanceof Error ? caughtError : new Error('Revoke transaction failed'));
    }
  };

  return { revoke, activeApprovalId, status, transactionHash, error };
}
