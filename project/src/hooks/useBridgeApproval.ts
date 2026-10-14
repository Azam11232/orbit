import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Address, type Hash } from 'viem';
import { getRpcReadFailureMessage } from '../wallet';
import { getBridgeErrorCategory, markArcForwardingTiming, recordArcForwardingFailure, timeArcForwardingAwait, type ArcForwardingTiming } from '../services/bridge/arcForwardingTiming';
import { getCircleForwardingApprovalAmount, getCircleForwardingApprovalTarget } from '../services/bridge/circleForwarding';
import type { BridgeQuote, BridgeToken } from '../types/bridge';

export function getBridgeApprovalRequest(quote: BridgeQuote | undefined, quoteCurrent: boolean) {
  if (!quote || !quoteCurrent) return { spender: null, amount: null };
  if (quote.selectedRoute === 'forwarding') {
    return {
      spender: getCircleForwardingApprovalTarget(quote.fromChain.id),
      amount: getCircleForwardingApprovalAmount(quote.fromChain.id, quote.fromAmount, quote.totalSourceDebit),
    };
  }
  return { spender: quote.transactionTarget, amount: quote.fromAmount };
}

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

export function getBridgeApprovalState(input: {
  hasToken: boolean;
  nativeToken: boolean;
  hasOwner: boolean;
  hasSpender: boolean;
  amount: bigint | null;
  allowance?: bigint;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isStale?: boolean;
}) {
  const isApplicable = input.hasToken && !input.nativeToken && input.hasOwner && input.amount !== null && input.amount > 0n;
  const isReady = !isApplicable || (input.hasSpender && input.allowance !== undefined && !input.isLoading && !input.isFetching && !input.isError && !input.isStale);
  const hasEnoughAllowance = input.allowance !== undefined && input.amount !== null && input.allowance >= input.amount;
  return {
    isReady,
    required: isApplicable && isReady && !hasEnoughAllowance,
  };
}

export function createBridgeApprovalOneShotGuard() {
  let locked = false;
  return {
    claim() {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() {
      locked = false;
    },
  };
}

export type BridgeApprovalStatus = 'idle' | 'checking' | 'confirmation' | 'pending' | 'confirmed' | 'failed';

export function getBridgeApprovalActionState(input: {
  required: boolean;
  isReady: boolean;
  sourceNetworkReady: boolean;
  status: BridgeApprovalStatus;
}) {
  const show = input.required && input.isReady && input.sourceNetworkReady;
  const disabled = input.status === 'checking' || input.status === 'confirmation' || input.status === 'pending';
  const label = input.status === 'checking'
    ? 'Checking allowance...'
    : input.status === 'pending'
      ? 'Approval pending...'
      : input.status === 'confirmation'
        ? 'Confirm in wallet'
        : input.status === 'failed'
          ? 'Retry approval'
          : 'Approve exact amount';
  return { show, disabled, label };
}

export function useBridgeApproval(token: BridgeToken | undefined, owner: Address | undefined, spender: Address | null, amount: bigint | null, timing?: ArcForwardingTiming) {
  const { chainId } = useAccount();
  const query = useReadContract({
    address: token?.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner && spender && token ? [owner, spender] : undefined,
    chainId: token?.chainId,
    query: { enabled: Boolean(token && !token.isNative && owner && spender && amount !== null && amount > 0n), staleTime: 5_000 },
  });
  const publicClient = usePublicClient({ chainId: token?.chainId });
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<BridgeApprovalStatus>('idle');
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);
  const approvalGuardRef = useRef(createBridgeApprovalOneShotGuard());
  const allowance = query.data ?? 0n;
  const approvalState = getBridgeApprovalState({
    hasToken: Boolean(token),
    nativeToken: Boolean(token?.isNative),
    hasOwner: Boolean(owner),
    hasSpender: Boolean(spender),
    amount,
    allowance: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isStale: query.isStale,
  });
  const required = approvalState.required;
  const amountKey = amount?.toString();
  useEffect(() => {
    setStatus('idle');
    setHash(undefined);
    setError(null);
  }, [token?.chainId, token?.address, spender, amountKey, owner]);
  useEffect(() => {
    if (!query.isStale || query.isFetching || query.isError || query.data === undefined || !token || !owner || !spender || amount === null || amount <= 0n) return;
    void query.refetch();
  }, [amount, owner, query.data, query.isError, query.isFetching, query.isStale, query.refetch, spender, token]);
  const approve = async () => {
    if (!token || token.isNative || !token.address || !spender || !owner || !amount || amount <= 0n || !publicClient) return;
    if (!approvalGuardRef.current.claim()) return;
    setStatus('checking');
    setHash(undefined);
    setError(null);
    try {
      if (chainId !== token.chainId) throw new Error(`Switch to the source network before approving ${token.symbol}`);
      const allowanceResult = await timeArcForwardingAwait(timing, 'approval allowance precheck', () => query.refetch());
      if (allowanceResult.isError || allowanceResult.data === undefined) {
        throw allowanceResult.error instanceof Error ? allowanceResult.error : new Error('Unable to verify the current USDC allowance');
      }
      if (hasSufficientBridgeAllowance(allowanceResult.data, amount)) {
        await queryClient.invalidateQueries({ queryKey: query.queryKey });
        setStatus('confirmed');
        markArcForwardingTiming(timing, 'approval already satisfied');
        return;
      }
      setStatus('confirmation');
      const gas = await timeArcForwardingAwait(timing, 'approval gas estimate', () => publicClient.estimateGas({
        account: owner,
        to: token.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
      }));
      const [gasPrice, nativeBalance] = await Promise.all([
        timeArcForwardingAwait(timing, 'approval gas price read', () => publicClient.getGasPrice()),
        timeArcForwardingAwait(timing, 'approval native balance read', () => publicClient.getBalance({ address: owner })),
      ]);
      if (nativeBalance < gas * gasPrice) throw new Error(`Insufficient ${token.chainId === 5042002 ? 'native USDC' : 'native gas'} balance for approval`);
      const txHash = await timeArcForwardingAwait(timing, 'approval wallet submission', () => writeContractAsync({ address: token.address, abi: erc20Abi, functionName: 'approve', args: [spender, amount], chainId: token.chainId }));
      setHash(txHash);
      setStatus('pending');
      const receipt = await timeArcForwardingAwait(timing, 'approval receipt wait', () => publicClient.waitForTransactionReceipt({ hash: txHash }));
      const approvalTx = await timeArcForwardingAwait(timing, 'approval transaction lookup', () => publicClient.getTransaction({ hash: txHash }));
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
      const directFreshAllowance = await timeArcForwardingAwait(timing, 'approval allowance verification', () => publicClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
      }));
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
      markArcForwardingTiming(timing, 'approval confirmed');
    } catch (caughtError) {
      recordArcForwardingFailure(timing, 'Bridge approval', caughtError);
      const readFailureMessage = caughtError instanceof Error ? getRpcReadFailureMessage(caughtError) : 'Bridge approval failed';
      if (import.meta.env.DEV) console.debug('[Orbit bridge] approval failed', { errorCategory: getBridgeErrorCategory(caughtError) });
      setStatus('failed');
      setError(new Error(readFailureMessage === 'Bridge approval failed' && caughtError instanceof Error ? caughtError.message : readFailureMessage));
    } finally {
      approvalGuardRef.current.release();
    }
  };
  return { allowance, required, isReady: approvalState.isReady, isLoading: query.isLoading || query.isFetching, isError: query.isError, isStale: query.isStale, approve, status, hash, error, refetchAllowance: query.refetch };
}
