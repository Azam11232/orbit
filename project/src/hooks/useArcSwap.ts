import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { type EIP1193Provider, type Hash } from 'viem';
import { estimateArcSwap, executeArcSwap, type ArcSwapQuote } from '../services/swap/arcSwap';
import { canSubmitArcSwap, createArcSwapRunGuard, resolveArcSwapWalletRejection } from '../services/swap/successLifecycle';
import { ArcSwapQuoteExpiredError, assertArcSwapQuoteFresh, createArcSwapQuoteQueryKey, isArcSwapQuoteFresh } from '../services/swap/quoteState';
import { isArcSwapRouteUnavailableError } from '../services/swap/quoteVerification';
import {
  accountArcSwapReceipt,
  type ArcSwapReceiptAccounting,
} from '../services/swap/receiptAccounting';
import {
  ArcSwapReceiptAccountingRequestManager,
  type ArcSwapReceiptAccountingGenerationIdentity,
  type ArcSwapReceiptAccountingIdentity,
  type ArcSwapReceiptAccountingResult,
  createArcSwapReceiptAccountingLifecycleCallbacks,
  retryArcSwapReceiptAccounting,
} from '../services/swap/receiptAccountingRetry';
import type { ArcSwapSymbol } from '../types/swap';
import {
  claimTransactionRecovery,
  inspectKnownTransactionReceipt,
  isRecoveryUnresolved,
  readTransactionRecovery,
  resolveRecoveryContext,
  resolveUnsubmittedTransactionRecovery,
  updateTransactionRecovery,
  updateTransactionRecoveryIfCurrent,
  type RecoveryStatus,
} from '../services/transactionRecovery';

function isApprovalRecoveryStep(step: string | undefined): boolean {
  return Boolean(step?.startsWith('swap-approval-'));
}

function getLastSwapTransactionHash(
  transactions: readonly { hash: Hash; step?: string }[],
): Hash | undefined {
  return [...transactions].reverse().find((transaction) => !isApprovalRecoveryStep(transaction.step))?.hash;
}

function hasApprovalOnlyTransactions(
  transactions: readonly { step?: string }[],
): boolean {
  return transactions.length > 0 && transactions.every((transaction) => isApprovalRecoveryStep(transaction.step));
}

export function useArcSwapQuote({
  provider,
  providerConnector,
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
}: {
  provider?: EIP1193Provider;
  providerConnector?: NonNullable<ReturnType<typeof useAccount>['connector']>;
  tokenIn: ArcSwapSymbol;
  tokenOut: ArcSwapSymbol;
  amountIn: string;
  slippageBps: number;
}) {
  const { address, chainId, connector } = useAccount();
  const publicClient = usePublicClient({ chainId: 5042002 });
  const isProviderForCurrentConnector = Boolean(provider && connector && providerConnector === connector);
  const enabled = Boolean(isProviderForCurrentConnector && publicClient && address && chainId === 5042002 && amountIn && tokenIn !== tokenOut);
  const queryKey = createArcSwapQuoteQueryKey({
    connectorId: connector?.uid,
    address,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
  });
  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!publicClient || !provider || !address) {
        throw new Error('Connect a wallet and Arc Testnet RPC before requesting a swap quote.');
      }
      return estimateArcSwap({
        provider,
        publicClient,
        walletAddress: address,
        tokenIn,
        tokenOut,
        amountIn,
        slippageBps,
      });
    },
    enabled,
    retry: (failureCount, error) => {
      const code = (error as Error & { code?: number }).code;
      return !isArcSwapRouteUnavailableError(error) && code !== 7001 && failureCount < 3;
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  return {
    queryKey,
    quote: query.data,
    dataUpdatedAt: query.dataUpdatedAt,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useArcSwapExecution(
  onConfirmed?: (
    identity: ArcSwapReceiptAccountingGenerationIdentity,
    isCurrent: () => boolean,
  ) => void | Promise<void>,
) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: 5042002 });
  const [state, setState] = React.useState<'idle' | 'pending' | 'executing' | 'confirming' | 'confirmed' | 'failed' | 'timeout' | 'rpc-error' | 'uncertain' | 'reverted'>(() => {
    if (!address) return 'idle';
    const saved = readTransactionRecovery(address, 'swap');
    if (saved.error) return 'uncertain';
    if (!saved.record) return 'idle';
    const context = resolveRecoveryContext(saved.record, address, [5042002]);
    if (context.type !== 'match') return 'uncertain';
    if (saved.record.status === 'confirmed') {
      return hasApprovalOnlyTransactions(saved.record.transactions) ? 'failed' : 'confirmed';
    }
    if (saved.record.status === 'reverted') return 'reverted';
    if (saved.record.status === 'timeout' || saved.record.status === 'rpc-error' || saved.record.status === 'uncertain') return saved.record.status;
    if (saved.record.status === 'wallet-request') return 'uncertain';
    return 'pending';
  });
  const [transactionHash, setTransactionHash] = React.useState<Hash | undefined>(() => {
    if (!address) return undefined;
    const transactions = readTransactionRecovery(address, 'swap').record?.transactions ?? [];
    return getLastSwapTransactionHash(transactions) ??
      (hasApprovalOnlyTransactions(transactions) ? transactions[transactions.length - 1]?.hash : undefined);
  });
  const [recovered, setRecovered] = React.useState(() => Boolean(address && readTransactionRecovery(address, 'swap').record));
  const [error, setError] = React.useState<Error | null>(null);
  const [receiptAccountingResult, setReceiptAccountingResult] = React.useState<ArcSwapReceiptAccountingResult<ArcSwapReceiptAccounting> | null>(null);
  const [receiptAccountingError, setReceiptAccountingError] = React.useState<string | null>(null);
  const [receiptStatusVerified, setReceiptStatusVerified] = React.useState(false);
  const [receiptAccountingLoading, setReceiptAccountingLoading] = React.useState(false);
  const [receiptAccountingRequestIdentity, setReceiptAccountingRequestIdentity] = React.useState<ArcSwapReceiptAccountingIdentity | null>(null);
  const [receiptAccountingRequestGeneration, setReceiptAccountingRequestGeneration] = React.useState<number | null>(null);
  const transactionHashOwner = React.useRef(address);
  const inFlight = React.useRef(false);
  const recoveryCheckInFlight = React.useRef(false);
  const runGuard = React.useRef(createArcSwapRunGuard());
  const receiptAccountingRequests = React.useRef(
    new ArcSwapReceiptAccountingRequestManager<ArcSwapReceiptAccounting>(),
  );
  const receiptAccountingRequest = receiptAccountingRequests.current;
  const receiptIdentity = React.useMemo(
    () => state === 'confirmed' && address && transactionHash &&
      transactionHashOwner.current?.toLowerCase() === address.toLowerCase()
      ? { walletAddress: address, transactionHash }
      : null,
    [address, state, transactionHash],
  );
  const receiptAccountingMatchesCurrent = Boolean(
    receiptIdentity &&
    receiptAccountingResult &&
    receiptAccountingResult.generation === receiptAccountingRequest.getCurrentGeneration(receiptIdentity) &&
    receiptAccountingResult.walletAddress.toLowerCase() === receiptIdentity.walletAddress.toLowerCase() &&
    receiptAccountingResult.transactionHash.toLowerCase() === receiptIdentity.transactionHash.toLowerCase(),
  );
  const receiptRequestMatchesCurrent = Boolean(
    receiptIdentity &&
    receiptAccountingRequestIdentity &&
    receiptAccountingRequestGeneration !== null &&
    receiptAccountingRequestGeneration === receiptAccountingRequest.getCurrentGeneration(receiptIdentity) &&
    receiptAccountingRequestIdentity.walletAddress.toLowerCase() === receiptIdentity.walletAddress.toLowerCase() &&
    receiptAccountingRequestIdentity.transactionHash.toLowerCase() === receiptIdentity.transactionHash.toLowerCase(),
  );
  const receiptAccounting = receiptAccountingMatchesCurrent ? receiptAccountingResult?.accounting ?? null : null;
  const receiptAccountingIdentity: ArcSwapReceiptAccountingGenerationIdentity | null =
    receiptAccountingMatchesCurrent && receiptAccountingResult
    ? {
        walletAddress: receiptAccountingResult.walletAddress,
        transactionHash: receiptAccountingResult.transactionHash,
        generation: receiptAccountingResult.generation,
      }
    : null;
  const receiptAccountingCurrentGeneration = receiptIdentity
    ? receiptAccountingRequest.getCurrentGeneration(receiptIdentity)
    : null;
  const currentReceiptAccountingError = receiptRequestMatchesCurrent ? receiptAccountingError : null;
  const currentReceiptStatusVerified = receiptRequestMatchesCurrent && receiptStatusVerified;
  const currentReceiptAccountingLoading = receiptRequestMatchesCurrent && receiptAccountingLoading;
  React.useLayoutEffect(() => {
    receiptAccountingRequest.activate();
    receiptAccountingRequest.setContext(receiptIdentity);
    return () => receiptAccountingRequest.dispose();
  }, [receiptAccountingRequest, receiptIdentity]);
  React.useEffect(() => {
    setReceiptAccountingResult(null);
    setReceiptAccountingError(null);
    setReceiptStatusVerified(false);
    setReceiptAccountingLoading(false);
    setReceiptAccountingRequestIdentity(null);
    setReceiptAccountingRequestGeneration(null);
    transactionHashOwner.current = address;
    if (!address) {
      setRecovered(false);
      setState('idle');
      setTransactionHash(undefined);
      setError(null);
      return;
    }
    const saved = readTransactionRecovery(address, 'swap');
    const context = saved.record ? resolveRecoveryContext(saved.record, address, [5042002]) : { type: 'none' as const };
    const transactions = context.type === 'match' ? context.record.transactions : [];
    const approvalOnly = hasApprovalOnlyTransactions(transactions);
    setRecovered(Boolean(context.type === 'match' && context.record.transactions.length));
    const nextHash = getLastSwapTransactionHash(transactions) ??
      (approvalOnly ? transactions[transactions.length - 1]?.hash : undefined);
    setTransactionHash(nextHash);
    setError(saved.error ?? (context.type === 'chain-mismatch'
      ? new Error('A previous Arc Swap transaction belongs to a different chain context. Verify wallet activity before submitting again.')
      : saved.record?.error ? new Error(saved.record.error) : null));
    if (saved.error || context.type === 'chain-mismatch') {
      setState('uncertain');
    } else if (context.type === 'match') {
      const savedStatus = context.record.status;
      setState(savedStatus === 'wallet-request'
        ? 'uncertain'
        : savedStatus === 'confirmed' && approvalOnly
          ? 'failed'
          : savedStatus);
      if (savedStatus === 'confirmed' && approvalOnly) {
        setError(new Error('Token approval was confirmed, but no swap transaction was submitted. Request a fresh quote before trying again.'));
      }
    } else {
      setState('idle');
    }
  }, [address]);
  const reset = React.useCallback(() => {
    if (inFlight.current || recoveryCheckInFlight.current) return;
    if (address) {
      const saved = readTransactionRecovery(address, 'swap');
      if (saved.error || (saved.record && isRecoveryUnresolved(saved.record.status))) return;
    }
    runGuard.current.invalidate();
    setState('idle');
    setTransactionHash(undefined);
    setRecovered(false);
    setError(null);
    setReceiptAccountingResult(null);
    setReceiptAccountingError(null);
    setReceiptStatusVerified(false);
    setReceiptAccountingLoading(false);
    setReceiptAccountingRequestIdentity(null);
    setReceiptAccountingRequestGeneration(null);
    receiptAccountingRequest.setContext(null);
  }, [address, receiptAccountingRequest]);

  const loadReceiptAccounting = React.useCallback(async (hash: Hash) => {
    if (!address || !publicClient) {
      if (address) {
        const identity = { walletAddress: address, transactionHash: hash };
        setReceiptAccountingRequestIdentity(identity);
        setReceiptAccountingRequestGeneration(receiptAccountingRequest.getCurrentGeneration(identity));
      }
      setReceiptAccountingLoading(false);
      setReceiptAccountingError('Actual swap amounts are unavailable because the Arc Testnet receipt RPC is unavailable.');
      return;
    }
    const identity = { walletAddress: address, transactionHash: hash };
    const requestGeneration = receiptAccountingRequest.getCurrentGeneration(identity);
    if (requestGeneration === null) return;
    await retryArcSwapReceiptAccounting(
      state,
      receiptAccountingRequest,
      identity,
      async () => {
        const [transaction, receipt] = await Promise.all([
          publicClient.getTransaction({ hash }),
          publicClient.getTransactionReceipt({ hash }),
        ]);
        if (
          transaction.hash.toLowerCase() !== hash.toLowerCase() ||
          receipt.transactionHash.toLowerCase() !== hash.toLowerCase()
        ) {
          throw new Error('Arc Testnet returned transaction data for a different Swap hash.');
        }
        if (
          receipt.status === 'success' &&
          receiptAccountingRequest.isCurrentGeneration(identity, requestGeneration)
        ) {
          setReceiptStatusVerified(true);
        }
        const blockResult = await Promise.allSettled([
          publicClient.getBlock({ blockNumber: receipt.blockNumber }),
        ]);
        const blockTimestamp = blockResult[0]?.status === 'fulfilled'
          ? blockResult[0].value.timestamp
          : undefined;
        const saved = readTransactionRecovery(address, 'swap');
        const approvalHashes = saved.record?.transactions
          .filter((entry) => isApprovalRecoveryStep(entry.step))
          .map((entry) => entry.hash) ?? [];
        const approvalReceiptResults = await Promise.allSettled(
          approvalHashes.map((approvalHash) => publicClient.getTransactionReceipt({ hash: approvalHash })),
        );
        const approvalGas = approvalReceiptResults.flatMap((result) =>
          result.status === 'fulfilled' && result.value.effectiveGasPrice !== undefined
            ? [result.value.gasUsed * result.value.effectiveGasPrice]
            : [],
        );
        const allGasReceiptsAvailable =
          !saved.error &&
          Boolean(saved.record?.transactions.some((entry) => entry.hash.toLowerCase() === hash.toLowerCase())) &&
          approvalGas.length === approvalHashes.length &&
          receipt.effectiveGasPrice !== undefined;
        const totalGasPaid = allGasReceiptsAvailable
          ? approvalGas.reduce((total, cost) => total + cost, receipt.gasUsed * receipt.effectiveGasPrice!)
          : null;
        return accountArcSwapReceipt({
          hash: transaction.hash,
          from: transaction.from,
          to: transaction.to,
          input: transaction.input,
          gasPrice: transaction.gasPrice,
        }, {
          transactionHash: receipt.transactionHash,
          status: receipt.status,
          blockTimestamp,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          logs: receipt.logs,
        }, address, {
          gasPaid: totalGasPaid,
        });
      },
      {
        ...createArcSwapReceiptAccountingLifecycleCallbacks({
          getGeneration: (requestIdentity) => receiptAccountingRequest.getCurrentGeneration(requestIdentity),
          setRequestIdentity: setReceiptAccountingRequestIdentity,
          setRequestGeneration: setReceiptAccountingRequestGeneration,
          setLoading: setReceiptAccountingLoading,
          clearResult: () => setReceiptAccountingResult(null),
          clearError: () => setReceiptAccountingError(null),
          clearVerifiedStatus: () => setReceiptStatusVerified(false),
          setResult: setReceiptAccountingResult,
          setError: setReceiptAccountingError,
        }),
        onAcknowledged: (result) => {
          const isCurrent = () => receiptAccountingRequest.isCurrentGeneration(result, requestGeneration);
          if (isCurrent()) void onConfirmed?.(result, isCurrent);
        },
      },
    );
  }, [address, onConfirmed, publicClient, receiptAccountingRequest, state]);

  const retryReceiptAccounting = React.useCallback(async () => {
    if (state !== 'confirmed' || !transactionHash) return;
    await loadReceiptAccounting(transactionHash);
  }, [loadReceiptAccounting, state, transactionHash]);

  React.useEffect(() => {
    if (state === 'confirmed' && transactionHash) {
      void loadReceiptAccounting(transactionHash);
    }
  }, [loadReceiptAccounting, state, transactionHash]);

  const retryRecoveryCheck = React.useCallback(async () => {
    if (!address || recoveryCheckInFlight.current) return;
    const saved = readTransactionRecovery(address, 'swap');
    if (saved.error || !saved.record) {
      setState('uncertain');
      setError(saved.error ?? new Error('No saved Arc Swap transaction is available to check.'));
      return;
    }
    if (resolveRecoveryContext(saved.record, address, [5042002]).type !== 'match') {
      setState('uncertain');
      setError(new Error('The saved Arc Swap transaction belongs to a different chain context.'));
      return;
    }
    const transactions = saved.record.transactions;
    const approvalOnly = hasApprovalOnlyTransactions(transactions);
    const hash = getLastSwapTransactionHash(transactions) ??
  (approvalOnly ? transactions[transactions.length - 1]?.hash : undefined);
    if (!hash) {
      setState('uncertain');
      setError(new Error('The wallet submission outcome is unknown and no transaction hash was saved. Check wallet activity before retrying.'));
      return;
    }
    if (!publicClient) {
      setState('rpc-error');
      setError(new Error('Arc Testnet RPC is unavailable. The saved swap remains unresolved.'));
      return;
    }
    recoveryCheckInFlight.current = true;
    const run = runGuard.current.start();
    const result = await inspectKnownTransactionReceipt(
      async () => publicClient.getTransactionReceipt({ hash }),
    );
    recoveryCheckInFlight.current = false;
    if (!runGuard.current.isCurrent(run)) return;
    const message = result.error?.message ?? (result.status === 'reverted'
      ? approvalOnly ? 'Token approval transaction reverted on Arc Testnet; no swap was submitted.' : 'Arc Swap transaction reverted on Arc Testnet.'
      : approvalOnly && result.status === 'confirmed'
        ? 'Token approval was confirmed, but no swap transaction was submitted. Request a fresh quote before trying again.'
        : undefined);
    const savedUpdate = await updateTransactionRecoveryIfCurrent(address, 'swap', saved.record.operationId, {
      status: result.status,
      error: message,
    }, saved.record.updatedAt);
    if (savedUpdate.stale || savedUpdate.error) {
      setError(savedUpdate.error ?? new Error('Arc Swap recovery changed while its receipt was being checked.'));
      if (savedUpdate.record) {
        const latest = getLastSwapTransactionHash(savedUpdate.record.transactions) ??
          (hasApprovalOnlyTransactions(savedUpdate.record.transactions)
            ? savedUpdate.record.transactions[savedUpdate.record.transactions.length - 1]?.hash
            : undefined);
        setTransactionHash(latest);
        setState(savedUpdate.record.status === 'wallet-request' ? 'uncertain' : savedUpdate.record.status);
      }
      return;
    }
    setState(result.status === 'confirmed'
      ? approvalOnly ? 'failed' : 'confirmed'
      : result.status === 'reverted'
        ? 'reverted'
        : result.status === 'timeout' || result.status === 'rpc-error' || result.status === 'uncertain'
          ? result.status
          : 'pending');
    setTransactionHash(approvalOnly && result.status === 'confirmed' ? undefined : hash);
    setError(message ? new Error(message) : null);
  }, [address, publicClient]);

  React.useEffect(() => {
    if (address && chainId === 5042002 && transactionHash && ['pending', 'timeout', 'rpc-error', 'uncertain'].includes(state)) {
      void retryRecoveryCheck();
    }
  }, [address, chainId, retryRecoveryCheck, state, transactionHash]);

  const execute = async ({
    provider,
    quote,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    quoteAmountIn,
    quoteUpdatedAt,
    quoteIsCurrent,
  }: {
    provider?: EIP1193Provider;
    quote: ArcSwapQuote;
    tokenIn: ArcSwapSymbol;
    tokenOut: ArcSwapSymbol;
    amountIn: string;
    slippageBps: number;
    quoteAmountIn: string;
    quoteUpdatedAt: number;
    quoteIsCurrent: boolean;
  }) => {
    if (!canSubmitArcSwap(state, inFlight.current)) return;
    if (!provider || !publicClient || !address || chainId !== 5042002) {
      setError(new Error('Connect your wallet and Arc Testnet RPC before swapping.'));
      setState('failed');
      return;
    }
    if (!quoteIsCurrent || !amountIn || amountIn !== quoteAmountIn || !isArcSwapQuoteFresh(quoteUpdatedAt)) {
      setError(new Error('Swap quote expired. Request a fresh quote before submitting.'));
      setState('failed');
      return;
    }

    inFlight.current = true;
    const run = runGuard.current.start();
    setState('executing');
    setError(null);
    setReceiptAccountingResult(null);
    setReceiptAccountingError(null);
    setReceiptStatusVerified(false);
    setTransactionHash(undefined);
    setRecovered(false);
    const claim = await claimTransactionRecovery(address, 'swap', [5042002]);
    if (!runGuard.current.isCurrent(run)) {
      inFlight.current = false;
      return;
    }
    if (claim.error || !claim.claimed) {
      inFlight.current = false;
      const saved = claim.record;
      setState(saved?.status === 'timeout' || saved?.status === 'rpc-error' || saved?.status === 'uncertain' ? saved.status : 'pending');
      const transactions = saved?.transactions ?? [];
      setTransactionHash(getLastSwapTransactionHash(transactions) ?? transactions[transactions.length - 1]?.hash);
      setError(claim.error ?? new Error('A previous Arc Swap transaction is unresolved. Check its saved hash before starting another.'));
      return;
    }
    const recoveryOperationId = claim.record?.operationId;
    if (!recoveryOperationId) {
      inFlight.current = false;
      setState('uncertain');
      setError(new Error('Arc Swap recovery operation identity is unavailable.'));
      return;
    }
    if (!isArcSwapQuoteFresh(quoteUpdatedAt)) {
      const cleanupError = await resolveUnsubmittedTransactionRecovery(
        address,
        'swap',
        ['swap'],
        recoveryOperationId,
      );
      inFlight.current = false;
      if (!runGuard.current.isCurrent(run)) return;
      if (cleanupError) {
        setState('uncertain');
        setError(new Error(`Swap quote expired, but its hashless recovery lock could not be safely cleared: ${cleanupError.message}`));
      } else {
        setState('failed');
        setError(new Error('Swap quote expired before wallet submission. Request a fresh quote.'));
      }
      return;
    }
    let submittedHash: Hash | undefined;
    let submittedSwapHash: Hash | undefined;
    let receiptConfirmed = false;
    let approvalConfirmed = false;
    let broadcastCount = 0;
    const persistBroadcast = (hash: Hash, kind: 'approval' | 'swap') => {
      submittedHash = hash;
      if (kind === 'swap') submittedSwapHash = hash;
      setTransactionHash(hash);
      if (runGuard.current.isCurrent(run) && kind === 'swap') setState('confirming');
      const saved = readTransactionRecovery(address, 'swap');
      if (saved.error || !saved.record || saved.record.operationId !== recoveryOperationId) {
        throw saved.error ?? new Error('Swap recovery intent is missing after transaction submission.');
      }
      if (saved.record.transactions.some((transaction) => transaction.hash.toLowerCase() === hash.toLowerCase())) return;
      broadcastCount += 1;
      const recoverySave = updateTransactionRecovery(address, 'swap', {
        status: 'pending',
        transactions: [
          ...saved.record.transactions,
          {
            chainId: 5042002,
            hash,
            step: kind === 'approval'
              ? `swap-approval-${broadcastCount}`
              : `swap-execution-${broadcastCount}`,
          },
        ],
        error: undefined,
      });
      if (recoverySave.error) throw recoverySave.error;
    };
    try {
      const result = await executeArcSwap({
        provider,
        publicClient,
        walletAddress: address,
        tokenIn,
        tokenOut,
        amountIn,
        slippageBps,
      }, quote, persistBroadcast, () => {
        approvalConfirmed = true;
      }, () => assertArcSwapQuoteFresh(quoteUpdatedAt));
      if (!runGuard.current.isCurrent(run)) return;
      if (!result.txHash) throw new Error('Arc Swap did not return a transaction hash');
      const resultHash = result.txHash;
      submittedHash = resultHash;
      submittedSwapHash = resultHash;
      setTransactionHash(resultHash);
      if (runGuard.current.isCurrent(run)) setState('confirming');
      const saved = readTransactionRecovery(address, 'swap');
      if (saved.error || !saved.record || saved.record.operationId !== recoveryOperationId) {
        throw saved.error ?? new Error('Swap recovery intent is missing after transaction submission.');
      }
      const transactions = saved.record.transactions.some((transaction) => transaction.hash.toLowerCase() === resultHash.toLowerCase())
        ? saved.record.transactions
        : [...saved.record.transactions, {
            chainId: 5042002,
            hash: resultHash,
            step: `swap-execution-${saved.record.transactions.length + 1}`,
          }];
      const pendingRecoverySave = updateTransactionRecovery(address, 'swap', {
        status: 'pending',
        transactions,
        error: undefined,
      });
      if (pendingRecoverySave.error) throw new Error(`Swap submitted with hash ${submittedHash}, but its recovery record could not be updated: ${pendingRecoverySave.error.message}`);
      const submittedRecoveryUpdatedAt = pendingRecoverySave.record?.updatedAt;
      if (!publicClient) throw new Error('Arc Testnet RPC is unavailable for receipt confirmation');
      const receipt = await Promise.race([
        publicClient.waitForTransactionReceipt({ hash: submittedHash }),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Arc Swap transaction confirmation timed out.')), 180_000)),
      ]);
      if (!runGuard.current.isCurrent(run)) return;
      if (receipt.status !== 'success') {
        const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'swap', recoveryOperationId, {
          status: 'reverted',
          error: 'Arc Swap transaction reverted on Arc Testnet.',
        }, submittedRecoveryUpdatedAt);
        if (recoverySave.error || recoverySave.stale) throw recoverySave.error ?? new Error('Arc Swap recovery operation changed.');
        setState('reverted');
        throw new Error('Arc Swap transaction reverted on Arc Testnet');
      }
      receiptConfirmed = true;
      const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'swap', recoveryOperationId, {
        status: 'confirmed',
        error: undefined,
      }, submittedRecoveryUpdatedAt);
      if (recoverySave.error || recoverySave.stale) throw recoverySave.error ?? new Error('Arc Swap recovery operation changed.');
      setState('confirmed');
    } catch (caughtError) {
      if (!runGuard.current.isCurrent(run)) return;
      const message = caughtError instanceof Error ? caughtError.message : 'Arc Swap failed';
      if (approvalConfirmed && !submittedSwapHash && submittedHash) {
        const approvalOnlyMessage = `${tokenIn} approval was confirmed, but no swap transaction was submitted: ${message}`;
        const saved = readTransactionRecovery(address, 'swap');
        const recoverySave = await updateTransactionRecoveryIfCurrent(
          address,
          'swap',
          recoveryOperationId,
          { status: 'confirmed', error: approvalOnlyMessage },
          saved.record?.updatedAt,
        );
        if (!runGuard.current.isCurrent(run)) return;
        if (recoverySave.error || recoverySave.stale) {
          setState('uncertain');
          setError(recoverySave.error ?? new Error(`Arc Swap recovery changed after ${tokenIn} approval.`));
        } else {
          setState('failed');
          setTransactionHash(undefined);
          setError(new Error(approvalOnlyMessage));
        }
        return;
      }
      if (caughtError instanceof ArcSwapQuoteExpiredError && !submittedHash) {
        const cleanupError = await resolveUnsubmittedTransactionRecovery(address, 'swap', ['swap'], recoveryOperationId);
        if (!runGuard.current.isCurrent(run)) return;
        if (cleanupError) {
          setState('uncertain');
          setError(new Error(`${message} The hashless recovery lock could not be safely cleared: ${cleanupError.message}`));
        } else {
          setState('failed');
          setError(caughtError);
        }
        return;
      }
      const walletRejection = await resolveArcSwapWalletRejection(
        caughtError,
        submittedSwapHash,
        () => resolveUnsubmittedTransactionRecovery(address, 'swap', ['swap'], recoveryOperationId),
      );
      if (!runGuard.current.isCurrent(run)) return;
      if (walletRejection.handled) {
        if (walletRejection.recoveryError) {
          setState('uncertain');
          setError(new Error(`Wallet rejection was detected, but its recovery record could not be safely cleared: ${walletRejection.recoveryError.message}`));
        } else {
          setState('failed');
          setError(new Error('Wallet request rejected. No transaction was submitted; you can try again.'));
        }
        return;
      }
      let recoverySaveError: Error | null = null;
      if (submittedHash) {
        const hash = submittedHash;
        const status: RecoveryStatus = /reverted/i.test(message)
          ? 'reverted'
          : /timed?\s*out|timeout|deadline exceeded/i.test(message)
            ? 'timeout'
            : 'rpc-error';
        const saved = readTransactionRecovery(address, 'swap');
        const transactions = saved.record?.transactions.some((transaction) =>
          transaction.hash.toLowerCase() === hash.toLowerCase(),
        )
          ? saved.record.transactions
          : [
              ...(saved.record?.transactions ?? []),
              { chainId: 5042002, hash, step: submittedSwapHash
                ? `swap-execution-${(saved.record?.transactions.length ?? 0) + 1}`
                : `swap-approval-${(saved.record?.transactions.length ?? 0) + 1}` },
            ];
        const recoverySave = await updateTransactionRecoveryIfCurrent(
          address,
          'swap',
          recoveryOperationId,
          { status, transactions, error: message },
          saved.record?.updatedAt,
        );
        recoverySaveError = recoverySave.error ?? (recoverySave.stale ? new Error('Arc Swap recovery changed while its receipt was being checked.') : null);
        if (!recoverySaveError) setState(status === 'reverted' ? 'reverted' : status);
      } else {
        const current = readTransactionRecovery(address, 'swap');
        const recoverySave = await updateTransactionRecoveryIfCurrent(
          address,
          'swap',
          recoveryOperationId,
          { status: 'uncertain', error: message },
          current.record?.updatedAt,
        );
        recoverySaveError = recoverySave.error ?? (recoverySave.stale ? new Error('Arc Swap recovery changed while its result was being saved.') : null);
        if (recoverySave.record?.transactions.length) {
          setTransactionHash(getLastSwapTransactionHash(recoverySave.record.transactions) ??
            recoverySave.record.transactions[recoverySave.record.transactions.length - 1]?.hash);
          setRecovered(true);
        }
        setState('uncertain');
      }
      setError(recoverySaveError ?? (caughtError instanceof Error ? caughtError : new Error('Arc Swap failed')));
    } finally {
      inFlight.current = false;
    }
    return receiptConfirmed;
  };

  return {
    execute,
    reset,
    retryRecoveryCheck,
    state,
    transactionHash,
    recovered,
    error,
    receiptAccounting,
    receiptAccountingIdentity,
    receiptAccountingCurrentGeneration,
    receiptAccountingError: currentReceiptAccountingError,
    receiptAccountingLoading: currentReceiptAccountingLoading,
    receiptStatusVerified: currentReceiptStatusVerified,
    retryReceiptAccounting,
  };
}
