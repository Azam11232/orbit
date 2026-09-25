import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Address, type Hash } from 'viem';
import { getRpcReadFailureMessage } from '../wallet';
import type { BridgeToken } from '../types/bridge';

export function hasSufficientBridgeAllowance(allowance: bigint, amount: bigint | null) {
  return amount !== null && amount > 0n && allowance >= amount;
}

export function resolveApprovalAllowanceResult(input: { directAllowance: bigint; hookAllowance: bigint; requiredAmount: bigint }) {
  const directSufficient = hasSufficientBridgeAllowance(input.directAllowance, input.requiredAmount);
  const hookSufficient = hasSufficientBridgeAllowance(input.hookAllowance, input.requiredAmount);
  return {
    directSufficient,
    hookSufficient,
    staleCache: directSufficient && !hookSufficient,
    shouldConfirm: directSufficient,
  };
}

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
    if (hasSufficientBridgeAllowance(currentAllowance, amount)) {
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
      const approvalTx = await publicClient.getTransaction({ hash: txHash });
      const decodedApproval = decodeFunctionData({
        abi: erc20Abi,
        data: approvalTx.input,
      });
      if (import.meta.env.DEV) {
        console.debug('[Orbit bridge] approval receipt', {
          hash: txHash,
          token: token.address,
          owner,
          spender,
          amount: amount.toString(),
          status: receipt.status,
          from: receipt.from,
          to: receipt.to,
          gasUsed: receipt.gasUsed.toString(),
          blockNumber: receipt.blockNumber.toString(),
          approvalTx: {
            to: approvalTx.to,
            from: approvalTx.from,
            function: decodedApproval.functionName,
            spender: decodedApproval.args?.[0],
            amount: decodedApproval.args?.[1]?.toString(),
          },
          logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics.slice(0, 3) })),
        });
      }
      if (receipt.status !== 'success') throw new Error('Bridge approval transaction reverted');
      const directFreshAllowance = await publicClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
      });
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
      const hookRefetchedAllowance = (await query.refetch()).data ?? 0n;
      const allowanceVerification = resolveApprovalAllowanceResult({
        directAllowance: directFreshAllowance,
        hookAllowance: hookRefetchedAllowance,
        requiredAmount: amount,
      });
      if (import.meta.env.DEV) {
        console.debug('[APPROVAL DEBUG]', {
          owner,
          token: token.address,
          spender,
          requestedApprovalAmount: amount.toString(),
          receiptStatus: receipt.status,
          receiptBlockNumber: receipt.blockNumber.toString(),
          freshDirectAllowance: directFreshAllowance.toString(),
          hookRefetchedAllowance: hookRefetchedAllowance.toString(),
          bridgeRequiredAmount: amount.toString(),
          staleCache: allowanceVerification.staleCache,
          directSufficient: allowanceVerification.directSufficient,
          hookSufficient: allowanceVerification.hookSufficient,
          chainId: token.chainId,
          approvalTx: {
            to: approvalTx.to,
            from: approvalTx.from,
            function: decodedApproval.functionName,
            spender: decodedApproval.args?.[0],
            amount: decodedApproval.args?.[1]?.toString(),
          },
        });
      }
      if (!allowanceVerification.shouldConfirm) {
        throw new Error('Approval confirmed, but allowance is still insufficient.');
      }
      if (allowanceVerification.staleCache) {
        queryClient.setQueryData(query.queryKey, directFreshAllowance);
      }
      await queryClient.invalidateQueries({ queryKey: ['bridge-simulation'] });
      setStatus('confirmed');
    } catch (caughtError) {
      const readFailureMessage = caughtError instanceof Error ? getRpcReadFailureMessage(caughtError) : 'Bridge approval failed';
      if (import.meta.env.DEV) console.debug('[Orbit bridge] approval failed', { token: token?.address, owner, spender, required: amount?.toString(), hash, error: caughtError instanceof Error ? caughtError.message : String(caughtError) });
      setStatus('failed');
      setError(new Error(readFailureMessage === 'Bridge approval failed' && caughtError instanceof Error ? caughtError.message : readFailureMessage));
    }
  };
  return { allowance, required, isLoading: query.isLoading, isError: query.isError, approve, status, hash, error, refetchAllowance: query.refetch };
}
