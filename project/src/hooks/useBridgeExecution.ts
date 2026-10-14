import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';
import { decodeEventLog, encodeFunctionData, erc20Abi, formatUnits, type Address, type EIP1193Provider, type Hash, type Hex } from 'viem';
import type { BridgeQuote, BridgeStatus } from '../types/bridge';
import { cctpMessageTransmitterAbi } from '../services/bridge/cctp';
import { CircleForwardingError, executeCircleForwarding, getForwardingPollRetryDelay, getForwardingStatusOutcome, isAuthoritativeForwardingSuccess, isCircleForwardingSupported, isFastArcSepoliaForwarding, pollCircleForwardingStatus } from '../services/bridge/circleForwarding';
import { getOrbitNetwork } from '../data/networks';
import { markArcForwardingTiming, recordArcForwardingFailure, timeArcForwardingAwait, timeArcForwardingSync, type ArcForwardingTiming } from '../services/bridge/arcForwardingTiming';
import { isSameBridgeQuoteSnapshot } from './useBridgeQuote';

export type BridgeExecutionStatus = 'idle' | 'preflight' | 'approval-required' | 'approval-pending' | 'approval-confirmed' | 'source-pending' | 'source-confirmed' | 'attestation-pending' | 'attestation-ready' | 'destination-pending' | 'destination-confirmed' | 'verification-pending' | 'completed' | 'error' | 'cancelled';
const QUOTE_MAX_AGE_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 180_000;
const FORWARDING_POLL_TIMEOUT_MS = 180_000;
export const FORWARDING_RECONCILIATION_INTERVAL_MS = 1_000;

export function getBridgeLifecycleStatus(status: BridgeExecutionStatus, forwarding: boolean, hashes: { source?: boolean; destination?: boolean } = {}) {
  if (status === 'approval-pending') return 'Confirm the USDC approval in your wallet.';
  if (status === 'approval-confirmed') return 'USDC approval confirmed. Preparing the source transfer.';
  if (status === 'preflight') return 'Checking the selected Bridge route.';
  if (status === 'source-pending') return hashes.source ? 'Source transaction submitted · Waiting for source confirmation.' : 'Confirm the source USDC transfer in your wallet.';
  if (status === 'source-confirmed') return forwarding ? 'Source confirmed · Circle forwarding' : 'Source confirmed · Waiting for Circle attestation.';
  if (status === 'attestation-pending') return 'Source confirmed · Waiting for Circle attestation.';
  if (status === 'attestation-ready') return 'Circle attestation received. Preparing destination confirmation.';
  if (status === 'destination-pending') return forwarding
    ? hashes.destination ? 'Circle forwarding transaction submitted · Verifying destination.' : 'Circle forwarding in progress.'
    : hashes.destination ? 'Destination mint submitted · Waiting for confirmation.' : 'Confirm the destination mint in your wallet.';
  if (status === 'destination-confirmed' || status === 'verification-pending') return 'Destination transaction confirmed';
  if (status === 'completed') return 'Bridge completed';
  return null;
}

export function getCompactBridgeStatus(
  status: BridgeExecutionStatus,
  forwarding: boolean,
  hashes: { source?: boolean; destination?: boolean; destinationVerified?: boolean } = {},
) {
  if (status === 'preflight') return 'Preparing transfer…';
  if (status === 'approval-required') return 'Approve USDC to continue.';
  if (status === 'approval-pending') return 'Confirm USDC approval in your wallet.';
  if (status === 'approval-confirmed') return 'Approval confirmed; preparing transfer.';
  if (status === 'source-pending') return hashes.source ? 'Waiting for source confirmation.' : 'Confirm the source transfer in your wallet.';
  if (status === 'source-confirmed' || status === 'attestation-pending') return forwarding ? 'Circle is processing the transfer.' : 'Waiting for Circle attestation.';
  if (status === 'attestation-ready') return forwarding ? 'Circle is processing the transfer.' : 'Confirm the destination mint in Ethereum Sepolia.';
  if (status === 'destination-pending') {
    if (forwarding) return hashes.destination ? 'Verifying the destination transfer.' : 'Circle is processing the transfer.';
    return hashes.destination ? 'Verifying the destination mint.' : 'Confirm the destination mint in your wallet.';
  }
  if (status === 'destination-confirmed' || status === 'verification-pending') return 'Verifying destination receipt.';
  if (status === 'completed') return hashes.destinationVerified ? 'Transfer complete; destination receipt verified.' : 'Verifying destination receipt.';
  return null;
}

export interface DestinationReceiptVerificationInput {
  receiptStatus: 'success' | 'reverted';
  receiptTo: string | null | undefined;
  expectedMessageTransmitter: Address;
  expectedToken: Address;
  recipient: Address;
  expectedAmount: bigint;
  requireExactAmount?: boolean;
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
}

export function verifyDestinationReceipt(input: DestinationReceiptVerificationInput) {
  if (input.receiptStatus !== 'success' || input.receiptTo?.toLowerCase() !== input.expectedMessageTransmitter.toLowerCase()) return false;
  return input.logs.some((log) => {
    if (log.address.toLowerCase() !== input.expectedToken.toLowerCase()) return false;
    try {
      const topics = [...log.topics] as [] | [Hex, ...Hex[]];
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics });
      if (decoded.eventName !== 'Transfer') return false;
      const args = decoded.args as { from: Address; to: Address; value: bigint };
      return args.to.toLowerCase() === input.recipient.toLowerCase() && (input.requireExactAmount === false ? args.value >= input.expectedAmount : args.value === input.expectedAmount);
    } catch {
      return false;
    }
  });
}

export function getRequiredSourceDebit(quote: Pick<BridgeQuote, 'fromAmount' | 'totalSourceDebit'>) {
  return quote.totalSourceDebit ?? quote.fromAmount;
}

export function shouldReadAppSourceBalance(input: { forwardingEnabled: boolean; sourceChainId: number; destinationChainId: number; fromAmount: bigint; totalSourceDebit?: bigint | null }) {
  return !(input.forwardingEnabled && isFastArcSepoliaForwarding(input.sourceChainId, input.destinationChainId) && input.totalSourceDebit === input.fromAmount);
}

export function canShowBridgeSuccess(input: { status: BridgeExecutionStatus; sourceHash?: Hash; destinationHash?: Hash; destinationVerified: boolean }) {
  return input.status === 'completed' && Boolean(input.sourceHash && input.destinationVerified);
}

export function shouldResetBridgeAmount(input: { status: BridgeExecutionStatus; sourceHash?: Hash; destinationHash?: Hash; destinationVerified: boolean }) {
  return canShowBridgeSuccess(input);
}

export function getRequiredBridgeChainId(input: { status: BridgeExecutionStatus; sourceChainId: number; destinationChainId: number; sourceHash?: Hash; forwarding?: boolean; verifiedComplete?: boolean; sourceActionReady?: boolean }): number | undefined {
  if (input.verifiedComplete || input.status === 'completed') return undefined;
  if (input.sourceHash) return undefined;
  if (input.status === 'preflight' || input.status === 'approval-required' || input.status === 'approval-pending' || input.status === 'approval-confirmed' || input.status === 'source-pending') {
    return input.sourceChainId;
  }
  if ((input.status === 'idle' || input.status === 'error') && input.sourceActionReady) return input.sourceChainId;
  return undefined;
}

export function shouldShowBridgeWrongNetwork(input: { isConnected: boolean; walletChainId?: number; requiredChainId?: number }) {
  return input.isConnected && input.requiredChainId !== undefined && input.walletChainId !== input.requiredChainId;
}

export function isBridgeWalletOnChain(walletChainId: number | undefined, requiredChainId: number) {
  return walletChainId === requiredChainId;
}

export function shouldSkipInitialForwardingStatusPoll(initialStatusAvailable: boolean) {
  return initialStatusAvailable;
}

export function canApplyForwardingPending(completed: boolean) {
  return !completed;
}

export function shouldReportForwardingReconciliationTimeout(input: { cancelled: boolean; completed: boolean }) {
  return !input.cancelled && !input.completed;
}

export function canRetryForwardingReconciliation(input: {
  status: BridgeExecutionStatus;
  selectedRoute?: BridgeQuote['selectedRoute'];
  sourceHash?: Hash;
  destinationVerified: boolean;
  timedOut: boolean;
}) {
  return input.status === 'error' &&
    input.selectedRoute === 'forwarding' &&
    Boolean(input.sourceHash) &&
    !input.destinationVerified &&
    input.timedOut;
}

export function shouldAutoCompleteBridge(input: { status: BridgeExecutionStatus; attestationReady: boolean; message?: Hex; attestation?: Hex; destinationHash?: Hash }) {
  const hasAttestation = Boolean(input.message && input.attestation);
  return Boolean(
    input.attestationReady &&
    hasAttestation &&
    (input.status === 'source-confirmed' || input.status === 'attestation-pending' || input.status === 'attestation-ready') &&
    !input.destinationHash
  );
}

export function canRetryDestinationMint(input: { status: BridgeExecutionStatus; selectedRoute?: BridgeQuote['selectedRoute']; sourceHash?: Hash; destinationHash?: Hash; destinationVerified: boolean; destinationSubmissionAttempted?: boolean; destinationSubmissionReverted?: boolean }) {
  const noSubmissionPossible = !input.destinationHash && !input.destinationSubmissionAttempted;
  return input.status === 'error' &&
    input.selectedRoute === 'cctp' &&
    Boolean(input.sourceHash) &&
    !input.destinationVerified &&
    (noSubmissionPossible || Boolean(input.destinationSubmissionReverted));
}

export interface BridgeProgressStep {
  label: string;
  state: 'complete' | 'active' | 'upcoming';
}

export function getCompactBridgeProgressSteps(
  status: BridgeExecutionStatus,
  route: BridgeQuote['selectedRoute'],
  input: { sourceHash?: boolean; destinationHash?: boolean; destinationVerified?: boolean; destinationSubmissionAttempted?: boolean } = {},
): BridgeProgressStep[] {
  if (status === 'idle' || status === 'cancelled') return [];
  const forwarding = route === 'forwarding';
  const steps = [
    'Preparing',
    'Confirm in wallet',
    'Source confirmed',
    'Processing transfer',
    ...(!forwarding ? [status === 'error' && input.destinationSubmissionAttempted ? 'Verify destination transaction' : 'Confirm destination mint'] : []),
    'Complete',
  ];
  const complete = status === 'completed' && input.destinationVerified === true;
  const activeIndex = complete
    ? steps.length - 1
    : status === 'completed'
      ? forwarding ? 3 : 4
      : status === 'preflight' || status === 'approval-confirmed'
      ? 0
      : status === 'approval-required' || status === 'approval-pending' || (status === 'source-pending' && !input.sourceHash)
        ? 1
        : status === 'source-pending'
          ? 2
          : status === 'source-confirmed' || status === 'attestation-pending'
            ? 3
            : status === 'attestation-ready'
              ? forwarding ? 3 : 4
              : status === 'destination-pending'
                ? forwarding || input.destinationHash ? 3 : 4
                : status === 'destination-confirmed' || status === 'verification-pending' || (status === 'error' && input.destinationHash)
                  ? steps.length - 1
                  : status === 'error' && input.sourceHash
                    ? forwarding ? 3 : 4
                    : 1;
  return steps.map((label, index) => ({
    label,
    state: complete || index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'upcoming',
  }));
}

export function getBridgeProgressSteps(
  status: BridgeExecutionStatus,
  route: BridgeQuote['selectedRoute'],
  hashes: { source?: boolean; destination?: boolean; destinationSubmissionAttempted?: boolean } = {},
): BridgeProgressStep[] {
  if (status === 'idle' || status === 'cancelled') return [];
  const forwarding = route === 'forwarding';
  const steps = [
    { id: 'prepare', label: 'Preparing transaction' },
    { id: 'source-wallet', label: status === 'approval-required' || status === 'approval-pending' ? 'Waiting for USDC approval confirmation' : 'Waiting for source wallet confirmation' },
    { id: 'source-submitted', label: 'Source transaction submitted' },
    { id: 'source-confirmed', label: forwarding ? 'Source confirmed · destination processing' : 'Source confirmed · waiting for Circle attestation' },
    ...(!forwarding ? [{ id: 'destination-wallet', label: status === 'error' && hashes.destinationSubmissionAttempted ? 'Destination submission uncertain · verify Sepolia activity' : 'Waiting for destination mint confirmation' }] : []),
    { id: 'destination-submitted', label: forwarding ? 'Destination transaction submitted · verifying' : 'Destination mint submitted' },
    { id: 'destination-completed', label: 'Destination completed' },
  ];
  const activeId = status === 'completed'
    ? 'destination-completed'
    : status === 'preflight' || status === 'approval-confirmed'
      ? 'prepare'
      : status === 'approval-required' || status === 'approval-pending' || (status === 'source-pending' && !hashes.source)
        ? 'source-wallet'
        : status === 'source-pending'
          ? 'source-submitted'
          : status === 'source-confirmed' || status === 'attestation-pending' || (forwarding && status === 'attestation-ready')
            ? 'source-confirmed'
            : status === 'attestation-ready' || (status === 'destination-pending' && !hashes.destination && !forwarding)
              ? 'destination-wallet'
              : status === 'destination-pending' && !hashes.destination
                ? 'source-confirmed'
                : status === 'destination-pending' || status === 'destination-confirmed' || status === 'verification-pending'
                  ? 'destination-submitted'
                  : status === 'error' && hashes.destination
                    ? 'destination-submitted'
                    : status === 'error' && hashes.source
                      ? (forwarding ? 'source-confirmed' : 'destination-wallet')
                      : 'prepare';
  const activeIndex = steps.findIndex((step) => step.id === activeId);
  return steps.map((step, index) => ({
    label: step.label,
    state: status === 'completed' || index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'upcoming',
  }));
}

export function isExplicitWalletRejection(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (record.code === 4001 || record.code === '4001' || record.name === 'UserRejectedRequestError') return true;
    current = record.cause;
  }
  return false;
}

export function shouldResetBridgeExecution(input: { status?: BridgeExecutionStatus; sourceHash?: Hash; routeChanged: boolean; amountChanged: boolean; accountChanged: boolean; sourceNetworkChanged: boolean }) {
  const status = input.status ?? 'idle';
  return status !== 'preflight' && !isBridgeExecutionStarted(status, input.sourceHash) && (input.routeChanged || input.amountChanged || input.accountChanged || input.sourceNetworkChanged);
}

export function isBridgeExecutionStarted(status: BridgeExecutionStatus, sourceHash?: Hash) {
  return Boolean(sourceHash) || status === 'preflight' || status === 'approval-pending' || status === 'approval-confirmed' || status === 'source-pending' || status === 'source-confirmed' || status === 'attestation-pending' || status === 'attestation-ready' || status === 'destination-pending' || status === 'destination-confirmed' || status === 'verification-pending' || status === 'completed';
}

export function createBridgeExecutionOneShotGuard() {
  const active = new Set<string>();
  return {
    claim(key: string) {
      if (active.has(key)) return false;
      active.add(key);
      return true;
    },
    release(key: string) {
      active.delete(key);
    },
    has(key: string) {
      return active.has(key);
    },
  };
}

export function useBridgeExecution(quote: BridgeQuote | undefined, executionStartedRef?: MutableRefObject<boolean>) {
  const { address, chainId, connector } = useAccount();
  const publicClient = usePublicClient({ chainId: quote?.fromChain.id });
  const destinationClient = usePublicClient({ chainId: quote?.toChain.id });
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<BridgeExecutionStatus>('idle');
  const [sourceHash, setSourceHash] = useState<Hash>();
  const [destinationHash, setDestinationHash] = useState<Hash>();
  const [destinationVerified, setDestinationVerified] = useState(false);
  const [forwardingReconciliationTimedOut, setForwardingReconciliationTimedOut] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const forwardingStatusSeededRef = useRef(false);
  const forwardingCompletedRef = useRef(false);
  const forwardingTimingRef = useRef<ArcForwardingTiming>();
  const activeQuoteRef = useRef<BridgeQuote>();
  const executionRecipientRef = useRef<Address>();
  const sourceSubmissionGuardRef = useRef(createBridgeExecutionOneShotGuard());
  const sourceSubmissionKeyRef = useRef<string | null>(null);
  const destinationCompletionGuardRef = useRef(createBridgeExecutionOneShotGuard());
  const destinationCompletionKeyRef = useRef<string | null>(null);
  const destinationSubmissionAttemptedRef = useRef(false);
  const destinationMintRevertedRef = useRef(false);
  const activeQuote = isBridgeExecutionStarted(status, sourceHash) ? activeQuoteRef.current ?? quote : quote;
  const reset = useCallback(() => {
    if (executionStartedRef) executionStartedRef.current = false;
    setStatus('idle');
    setSourceHash(undefined);
    setDestinationHash(undefined);
    setDestinationVerified(false);
    setForwardingReconciliationTimedOut(false);
    destinationSubmissionAttemptedRef.current = false;
    destinationMintRevertedRef.current = false;
    setError(null);
    forwardingStatusSeededRef.current = false;
    forwardingCompletedRef.current = false;
    activeQuoteRef.current = undefined;
    executionRecipientRef.current = undefined;
    if (sourceSubmissionKeyRef.current) {
      sourceSubmissionGuardRef.current.release(sourceSubmissionKeyRef.current);
      sourceSubmissionKeyRef.current = null;
    }
    if (destinationCompletionKeyRef.current) {
      destinationCompletionGuardRef.current.release(destinationCompletionKeyRef.current);
      destinationCompletionKeyRef.current = null;
    }
    queryClient.removeQueries({ queryKey: ['bridge-status'] });
  }, [executionStartedRef, queryClient]);
  const beginReview = useCallback(() => {
    setError(null);
    setStatus((current) => current === 'idle' || current === 'error' ? 'preflight' : current);
  }, []);

  useEffect(() => {
    if (status !== 'destination-pending' || !sourceHash || !address || !connector || !activeQuote || !isCircleForwardingSupported(activeQuote.fromChain.id, activeQuote.toChain.id)) return;
    const recipient = executionRecipientRef.current ?? address;
    let cancelled = false;
    const startedAt = Date.now();
    const reconcile = async () => {
      setForwardingReconciliationTimedOut(false);
      if (shouldSkipInitialForwardingStatusPoll(forwardingStatusSeededRef.current)) {
        forwardingStatusSeededRef.current = false;
        await new Promise<void>((resolve) => window.setTimeout(resolve, FORWARDING_RECONCILIATION_INTERVAL_MS));
        if (cancelled || forwardingCompletedRef.current) return;
      }
      while (!cancelled && Date.now() - startedAt < FORWARDING_POLL_TIMEOUT_MS) {
        try {
          const provider = await timeArcForwardingAwait(forwardingTimingRef.current, 'wallet provider acquisition for status poll', () => connector.getProvider());
          const forwardingPollRetryDelay = getForwardingPollRetryDelay(activeQuote.fromChain.id, activeQuote.toChain.id);
          const forwarding = await pollCircleForwardingStatus({
            provider: provider as EIP1193Provider,
            sourceChainId: activeQuote.fromChain.id,
            sourceHash,
            recipient,
            timing: forwardingTimingRef.current,
            pollingConfig: isFastArcSepoliaForwarding(activeQuote.fromChain.id, activeQuote.toChain.id) ? { maxRetries: 1, retryDelay: forwardingPollRetryDelay } : undefined,
          });
          if (forwarding) markArcForwardingTiming(forwardingTimingRef.current, 'Circle status response received');
          if (forwarding?.forwardTxHash) markArcForwardingTiming(forwardingTimingRef.current, 'destination hash received');
          if (cancelled) return;
          const outcome = getForwardingStatusOutcome(forwarding?.forwardState, forwarding?.forwardTxHash);
          if (outcome === 'failed') {
            setForwardingReconciliationTimedOut(false);
            recordArcForwardingFailure(forwardingTimingRef.current, 'Circle forwarding status', new Error(forwarding?.forwardErrorDetails ?? forwarding?.forwardErrorCode ?? 'Circle forwarder reported FAILED'));
            setStatus('error');
            setError(new Error(`Circle forwarding failed: ${forwarding?.forwardErrorDetails ?? forwarding?.forwardErrorCode ?? 'Circle forwarder reported FAILED'}`));
            return;
          }
          const authoritativeForwardingSuccess = isAuthoritativeForwardingSuccess(forwarding ?? { forwardState: undefined, forwardTxHash: destinationHash });
          if ((forwarding && outcome === 'completed' && authoritativeForwardingSuccess) || Boolean(destinationHash && destinationHash.length > 2)) {
            const confirmedHash = forwarding?.forwardTxHash as Hash | undefined ?? destinationHash;
            if (!confirmedHash || !destinationClient) {
              await new Promise<void>((resolve) => window.setTimeout(resolve, FORWARDING_RECONCILIATION_INTERVAL_MS));
              continue;
            }
            markArcForwardingTiming(forwardingTimingRef.current, 'destination receipt wait started');
            const receipt = await timeArcForwardingAwait(forwardingTimingRef.current, 'destination receipt wait', () => destinationClient.waitForTransactionReceipt({ hash: confirmedHash, pollingInterval: FORWARDING_RECONCILIATION_INTERVAL_MS }));
            markArcForwardingTiming(forwardingTimingRef.current, 'destination receipt confirmed');
            const destination = getOrbitNetwork(activeQuote.toChain.id);
            const receiptVerified = timeArcForwardingSync(forwardingTimingRef.current, 'destination receipt verification', () => Boolean(destination && verifyDestinationReceipt({
              receiptStatus: receipt.status,
              receiptTo: receipt.to,
              expectedMessageTransmitter: destination.messageTransmitterV2,
              expectedToken: destination.usdc,
              recipient,
              expectedAmount: activeQuote.toAmount ?? activeQuote.fromAmount,
              requireExactAmount: false,
              logs: receipt.logs,
            })));
            if (!receiptVerified) {
              setStatus('error');
              setError(new Error('Circle forwarding destination receipt did not verify the expected USDC transfer'));
              return;
            }
            forwardingCompletedRef.current = true;
            setDestinationHash(confirmedHash);
            setDestinationVerified(true);
            queryClient.setQueryData<BridgeStatus>(['bridge-status', activeQuote.id, sourceHash.toString()], {
              status: 'DONE',
              substatus: 'Circle forwarding destination confirmed',
              receiving: { txHash: confirmedHash ?? undefined, chainId: activeQuote.toChain.id },
              sending: { txHash: sourceHash, chainId: activeQuote.fromChain.id },
            });
            markArcForwardingTiming(forwardingTimingRef.current, 'success state set');
            setStatus('completed');
            return;
          }
        } catch (caughtError) {
          recordArcForwardingFailure(forwardingTimingRef.current, 'Circle forwarding reconciliation poll', caughtError);
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, FORWARDING_RECONCILIATION_INTERVAL_MS));
      }
      if (shouldReportForwardingReconciliationTimeout({ cancelled, completed: forwardingCompletedRef.current })) {
        const timeoutError = new Error('Circle forwarding could not be verified before timeout. The source burn is confirmed; check Circle forwarding status and destination activity before attempting recovery.');
        recordArcForwardingFailure(forwardingTimingRef.current, 'Circle forwarding reconciliation timeout', timeoutError);
        setForwardingReconciliationTimedOut(true);
        setStatus('error');
        setError(timeoutError);
      }
    };
    void reconcile();
    return () => { cancelled = true; };
  }, [activeQuote, address, connector, queryClient, sourceHash, status]);
  const execute = async (timing?: ArcForwardingTiming, reviewedQuote?: BridgeQuote) => {
    forwardingTimingRef.current = timing;
    markArcForwardingTiming(timing, 'execute() started');
    setError(null);
    if (reviewedQuote && (!quote || !isSameBridgeQuoteSnapshot(quote, reviewedQuote) || Date.now() - reviewedQuote.quotedAt > QUOTE_MAX_AGE_MS)) {
      setError(new Error('The reviewed Circle quote changed or expired. Review the current quote again before confirming.'));
      return undefined;
    }
    if (quote) activeQuoteRef.current = quote;
    if (status !== 'idle' && status !== 'preflight' && status !== 'error' && status !== 'cancelled') return;
    if (status === 'error' && sourceHash) {
      const nextError = new Error('Bridge source transaction already exists. Resolve the destination step instead of submitting another burn');
      setError(nextError);
      return;
    }
    const sourceSubmissionKey = [
      quote?.fromChain.id,
      quote?.toChain.id,
      address,
      quote?.fromAmount?.toString(),
      quote?.transactionTarget ?? 'no-target',
      quote?.transactionData ?? 'no-data',
      quote?.selectedRoute ?? 'route',
    ].join(':');
    if (!sourceSubmissionGuardRef.current.claim(sourceSubmissionKey)) {
      return;
    }
    sourceSubmissionKeyRef.current = sourceSubmissionKey;
    let sourceTransactionSubmitted = false;
    const releaseSourceSubmission = () => {
      if (sourceSubmissionKeyRef.current === sourceSubmissionKey) {
        sourceSubmissionGuardRef.current.release(sourceSubmissionKey);
        sourceSubmissionKeyRef.current = null;
      }
      if (!sourceTransactionSubmitted && executionStartedRef) executionStartedRef.current = false;
    };
    if (address) executionRecipientRef.current = address;
    forwardingStatusSeededRef.current = false;
    forwardingCompletedRef.current = false;
    if (executionStartedRef) executionStartedRef.current = true;
    setStatus('preflight');
    if (!quote || !address || !publicClient) { const nextError = new Error('Bridge quote or source RPC is unavailable'); setStatus('error'); setError(nextError); releaseSourceSubmission(); return; }
    if (!isBridgeWalletOnChain(chainId, quote.fromChain.id)) { const nextError = new Error(`Switch to ${quote.fromChain.name} before bridging`); setStatus('error'); setError(nextError); releaseSourceSubmission(); return; }
    if (Date.now() - quote.quotedAt > QUOTE_MAX_AGE_MS) { const nextError = new Error('Bridge quote expired. Refresh the quote'); setStatus('error'); setError(nextError); releaseSourceSubmission(); return; }
    const selectedRoute = quote.selectedRoute ?? (isCircleForwardingSupported(quote.fromChain.id, quote.toChain.id) ? 'forwarding' : 'cctp');
    const forwardingEnabled = selectedRoute === 'forwarding';
    if (!forwardingEnabled && (!quote.transactionTarget || !quote.transactionData || quote.transactionData === '0x')) { const nextError = new Error('Bridge transaction data is incomplete'); setStatus('error'); setError(nextError); releaseSourceSubmission(); return; }
    try {
    const readAppSourceBalance = shouldReadAppSourceBalance({
      forwardingEnabled,
      sourceChainId: quote.fromChain.id,
      destinationChainId: quote.toChain.id,
      fromAmount: quote.fromAmount,
      totalSourceDebit: quote.totalSourceDebit,
    });
    const currentBalancePromise = !readAppSourceBalance
      ? Promise.resolve(undefined)
      : timeArcForwardingAwait(timing, 'app source balance read', () => quote.fromToken.isNative
        ? publicClient.getBalance({ address })
        : publicClient.readContract({ address: quote.fromToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }));
    if (!readAppSourceBalance) markArcForwardingTiming(timing, 'app source balance check skipped');
    const providerPromise = forwardingEnabled && connector
      ? timeArcForwardingAwait(timing, 'provider acquisition', () => connector.getProvider())
      : undefined;
    const [currentBalance, provider] = await Promise.all([currentBalancePromise, providerPromise]);
    if (currentBalance !== undefined && currentBalance < getRequiredSourceDebit(quote)) { const nextError = new Error('Insufficient source-chain balance for the quoted transfer and fees'); setStatus('error'); setError(nextError); releaseSourceSubmission(); return; }
    const actualSourceChainId = connector
      ? await timeArcForwardingAwait(timing, 'source wallet chain verification', () => connector.getChainId())
      : chainId;
    if (!isBridgeWalletOnChain(actualSourceChainId, quote.fromChain.id)) {
      throw new Error(`Wallet is on chain ${actualSourceChainId ?? 'unknown'}. Switch to ${quote.fromChain.name} before submitting the bridge.`);
    }
    const preflightTarget = quote.transactionTarget;
    const preflightData = quote.transactionData;
    if (!forwardingEnabled) {
      if (!preflightTarget || !preflightData) throw new Error('Bridge transaction data is incomplete');
      const code = await timeArcForwardingAwait(timing, 'source contract preflight', () => publicClient.getBytecode({ address: preflightTarget }));
      if (!code || code === '0x') { const nextError = new Error('Bridge transaction target is not a contract on the source chain'); setStatus('error'); setError(nextError); releaseSourceSubmission(); return; }
      if (quote.fromToken.isNative && quote.transactionValue !== quote.fromAmount) { const nextError = new Error('Bridge value does not match the quoted amount'); setStatus('error'); setError(nextError); releaseSourceSubmission(); return; }
    }
      if (!forwardingEnabled) {
        if (!destinationClient) throw new Error('Destination RPC is unavailable for gas preflight');
        const destination = getOrbitNetwork(quote.toChain.id);
        if (!destination) throw new Error('Destination network is not configured for CCTP');
        if (!preflightTarget || !preflightData) throw new Error('Bridge transaction data is incomplete');
        const destinationNativeBalance = await timeArcForwardingAwait(timing, 'destination gas balance preflight', () => destinationClient.getBalance({ address }));
        if (destinationNativeBalance === 0n) throw new Error(`Destination gas required: your wallet needs ${destination.nativeCurrency.symbol} on ${quote.toChain.name} to complete the destination mint`);
        const [gas, gasPrice, nativeBalance] = await Promise.all([
          timeArcForwardingAwait(timing, 'source transaction gas estimate', () => publicClient.estimateGas({ account: address, to: preflightTarget, data: preflightData, value: quote.transactionValue })),
          timeArcForwardingAwait(timing, 'source gas price read', () => publicClient.getGasPrice()),
          timeArcForwardingAwait(timing, 'source gas balance preflight', () => publicClient.getBalance({ address })),
        ]);
        if (nativeBalance < gas * gasPrice) throw new Error(`Insufficient ${getOrbitNetwork(quote.fromChain.id)?.nativeCurrency.symbol ?? 'native gas'} balance for bridge transaction`);
      }

      if (forwardingEnabled) {
        if (!provider) throw new Error('Connected wallet provider is unavailable for Circle forwarding');
        const forwardingQuote = quote.raw && typeof quote.raw === 'object' && 'quote' in quote.raw ? (quote.raw as { quote?: unknown }).quote : undefined;
        setStatus('source-pending');
        const forwarded = await executeCircleForwarding({
          provider: provider as EIP1193Provider,
          sourceChainId: quote.fromChain.id,
          destinationChainId: quote.toChain.id,
          recipient: address,
          amount: quote.fromAmount,
          quote: forwardingQuote,
          destinationAmount: quote.toAmount ?? undefined,
          totalSourceDebit: quote.totalSourceDebit ?? undefined,
          timing,
          onStep: (step) => {
            const stepName = step.name.toLowerCase();
            if (stepName === 'approve' && step.state === 'pending') {
              setStatus('approval-pending');
            } else if (stepName === 'approve' && step.state === 'success') {
              setStatus('approval-confirmed');
            } else if (stepName === 'burn' && step.state === 'pending' && step.txHash) {
              sourceTransactionSubmitted = true;
              setSourceHash(step.txHash as Hash);
              setStatus('source-pending');
            } else if (stepName === 'burn' && step.state === 'success' && step.txHash) {
              sourceTransactionSubmitted = true;
              markArcForwardingTiming(timing, 'source tx hash available');
              markArcForwardingTiming(timing, 'source receipt confirmed');
              setSourceHash(step.txHash as Hash);
              setStatus('source-confirmed');
            } else if (stepName === 'fetchattestation' && step.state === 'pending') {
              setStatus('attestation-pending');
            } else if (stepName === 'fetchattestation' && step.state === 'success') {
              setStatus('attestation-ready');
            } else if (stepName === 'mint' && step.state === 'pending') {
              setStatus('destination-pending');
            } else if (stepName === 'mint' && step.state === 'success' && step.txHash) {
              markArcForwardingTiming(timing, 'destination hash received');
              setDestinationHash(step.txHash as Hash);
              setStatus('verification-pending');
            }
          },
        });
        forwardingStatusSeededRef.current = true;
        setSourceHash(forwarded.sourceHash);
        if (forwardingCompletedRef.current) return forwarded.sourceHash;
        setStatus('destination-pending');
        if (forwarded.pending) {
          if (!canApplyForwardingPending(forwardingCompletedRef.current)) return forwarded.sourceHash;
          queryClient.setQueryData<BridgeStatus>(['bridge-status', quote.id, forwarded.sourceHash.toString()], {
            status: 'PENDING',
            substatus: 'Circle forwarding is processing the destination mint',
            sending: { txHash: forwarded.sourceHash, chainId: quote.fromChain.id },
          });
          return forwarded.sourceHash;
        }
        sourceTransactionSubmitted = true;
        setDestinationHash(forwarded.destinationHash);
        if (!forwarded.destinationHash) return forwarded.sourceHash;
        setStatus('verification-pending');
        const authoritativeForwardingSuccess = forwarded.forwarding ? isAuthoritativeForwardingSuccess(forwarded.forwarding) : Boolean(forwarded.destinationHash);
        if (!authoritativeForwardingSuccess) throw new Error('Circle forwarding completed without an authoritative destination result');
        if (!destinationClient) throw new Error('Destination RPC is unavailable for Circle forwarding verification');
        const confirmedDestinationHash = forwarded.destinationHash;
        markArcForwardingTiming(timing, 'destination receipt wait started');
        const destinationReceipt = await timeArcForwardingAwait(timing, 'destination receipt wait', () => Promise.race([
          destinationClient.waitForTransactionReceipt({ hash: confirmedDestinationHash, pollingInterval: FORWARDING_RECONCILIATION_INTERVAL_MS }),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Destination transaction confirmation timed out')), RECEIPT_TIMEOUT_MS)),
        ]));
        markArcForwardingTiming(timing, 'destination receipt confirmed');
        const destination = getOrbitNetwork(quote.toChain.id);
        const receiptVerified = Boolean(destination && verifyDestinationReceipt({
          receiptStatus: destinationReceipt.status,
          receiptTo: destinationReceipt.to,
          expectedMessageTransmitter: destination.messageTransmitterV2,
          expectedToken: destination.usdc,
          recipient: address,
          expectedAmount: forwarded.destinationAmount,
          requireExactAmount: false,
          logs: destinationReceipt.logs,
        }));
        if (!receiptVerified) throw new Error('Circle forwarding destination receipt did not verify the expected USDC transfer');
        forwardingCompletedRef.current = true;
        setDestinationVerified(true);
        queryClient.setQueryData<BridgeStatus>(['bridge-status', quote.id, forwarded.sourceHash.toString()], {
          status: 'DONE',
          substatus: 'Circle forwarding destination confirmed',
          receiving: { txHash: forwarded.destinationHash, chainId: quote.toChain.id },
          sending: { txHash: forwarded.sourceHash, chainId: quote.fromChain.id },
        });
        markArcForwardingTiming(timing, 'success state set');
        setStatus('completed');
        return forwarded.sourceHash;
      }

      setStatus('source-pending');
      const transactionTarget = quote.transactionTarget;
      const transactionData = quote.transactionData;
      if (!transactionTarget || !transactionData) throw new Error('Bridge transaction data is incomplete');
      const hash = await timeArcForwardingAwait(timing, 'source wallet submission', () => sendTransactionAsync({ to: transactionTarget, data: transactionData, value: quote.transactionValue, chainId: quote.fromChain.id }));
      sourceTransactionSubmitted = true;
      markArcForwardingTiming(timing, 'source tx hash available');
      setSourceHash(hash); setStatus('source-pending');
      const sourceReceipt = await timeArcForwardingAwait(timing, 'source receipt wait', () => Promise.race([publicClient.waitForTransactionReceipt({ hash }), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Source transaction confirmation timed out')), RECEIPT_TIMEOUT_MS))]));
      if (sourceReceipt.status !== 'success' || sourceReceipt.to?.toLowerCase() !== transactionTarget.toLowerCase()) throw new Error('Bridge source transaction did not confirm against the quoted source contract');
      markArcForwardingTiming(timing, 'source receipt confirmed');
      setStatus('source-confirmed');
      await queryClient.invalidateQueries();
      return hash;
    } catch (caughtError) {
      recordArcForwardingFailure(timing, 'Bridge source execution', caughtError);
      if (caughtError instanceof CircleForwardingError) {
        if (caughtError.sourceHash) {
          sourceTransactionSubmitted = true;
          setSourceHash(caughtError.sourceHash);
        }
        if (caughtError.destinationHash) setDestinationHash(caughtError.destinationHash);
      }
      releaseSourceSubmission();
      setStatus('error'); setError(caughtError instanceof Error ? caughtError : new Error('Bridge transaction failed')); return undefined;
    }
  };
  const markAttestationPending = useCallback(() => {
    setStatus((current) => current === 'source-confirmed' ? 'attestation-pending' : current);
  }, []);
  const markAttestationReady = useCallback(() => {
    setStatus((current) => current === 'source-confirmed' || current === 'attestation-pending' ? 'attestation-ready' : current);
  }, []);
  const retryForwardingReconciliation = useCallback(() => {
    if (!canRetryForwardingReconciliation({
      status,
      selectedRoute: quote?.selectedRoute,
      sourceHash,
      destinationVerified,
      timedOut: forwardingReconciliationTimedOut,
    })) return;
    setForwardingReconciliationTimedOut(false);
    setError(null);
    setStatus('destination-pending');
  }, [destinationVerified, forwardingReconciliationTimedOut, quote?.selectedRoute, sourceHash, status]);
  const complete = async (message: Hex | undefined, attestation: Hex | undefined) => {
    setError(null);
    const recipient = executionRecipientRef.current ?? address;
    const retryingDestinationMint = canRetryDestinationMint({
      status,
      selectedRoute: quote?.selectedRoute,
      sourceHash,
      destinationHash,
      destinationVerified,
      destinationSubmissionAttempted: destinationSubmissionAttemptedRef.current,
      destinationSubmissionReverted: destinationMintRevertedRef.current,
    });
    if ((status !== 'source-confirmed' && status !== 'attestation-pending' && status !== 'attestation-ready' && !retryingDestinationMint) || !address || !recipient || !quote || !message || !attestation || !destinationClient) {
      const nextError = new Error('Circle attestation is not ready for destination mint');
      setStatus('error');
      setError(nextError);
      return undefined;
    }
    const destinationCompletionKey = `${sourceHash ?? quote.id}:${message}:${attestation}`;
    if (!destinationCompletionGuardRef.current.claim(destinationCompletionKey)) {
      return undefined;
    }
    destinationCompletionKeyRef.current = destinationCompletionKey;
    const destination = getOrbitNetwork(quote.toChain.id);
    if (!destination) {
      const nextError = new Error('Destination network is not configured for CCTP');
      setStatus('error');
      setError(nextError);
      destinationCompletionGuardRef.current.release(destinationCompletionKey);
      destinationCompletionKeyRef.current = null;
      return undefined;
    }
    let previousDestinationMintReverted = false;
    try {
      if (address.toLowerCase() !== recipient.toLowerCase()) throw new Error('Reconnect the wallet used for the source burn before completing the destination mint');
      setStatus('attestation-ready');
      await timeArcForwardingAwait(forwardingTimingRef.current, 'destination wallet chain switch', () => switchChainAsync({ chainId: quote.toChain.id }));
      const data = encodeFunctionData({ abi: cctpMessageTransmitterAbi, functionName: 'receiveMessage', args: [message, attestation] });
      const [gas, gasPrice, nativeBalance] = await Promise.all([
        timeArcForwardingAwait(forwardingTimingRef.current, 'destination transaction gas estimate', () => destinationClient.estimateGas({ account: address, to: destination.messageTransmitterV2, data, value: 0n })),
        timeArcForwardingAwait(forwardingTimingRef.current, 'destination gas price read', () => destinationClient.getGasPrice()),
        timeArcForwardingAwait(forwardingTimingRef.current, 'destination gas balance check', () => destinationClient.getBalance({ address })),
      ]);
      const destinationGasRequired = gas * gasPrice;
      if (nativeBalance < destinationGasRequired) throw new Error(`Insufficient ${destination.nativeCurrency.symbol} for destination mint: requires approximately ${formatUnits(destinationGasRequired, destination.nativeCurrency.decimals)} ${destination.nativeCurrency.symbol}, wallet has ${formatUnits(nativeBalance, destination.nativeCurrency.decimals)} ${destination.nativeCurrency.symbol}`);

      setStatus('destination-pending');
      previousDestinationMintReverted = destinationMintRevertedRef.current;
      destinationMintRevertedRef.current = false;
      destinationSubmissionAttemptedRef.current = true;
      const hash = await timeArcForwardingAwait(forwardingTimingRef.current, 'destination wallet submission', () => sendTransactionAsync({ to: destination.messageTransmitterV2, data, value: 0n, chainId: quote.toChain.id }));
      markArcForwardingTiming(forwardingTimingRef.current, 'destination hash available');
      setDestinationHash(hash);
      const destinationReceipt = await timeArcForwardingAwait(forwardingTimingRef.current, 'destination receipt wait', () => Promise.race([destinationClient.waitForTransactionReceipt({ hash }), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Destination transaction confirmation timed out')), RECEIPT_TIMEOUT_MS))]));
      if (destinationReceipt.status !== 'success') {
        destinationMintRevertedRef.current = true;
        throw new Error('Bridge destination transaction reverted');
      }
      markArcForwardingTiming(forwardingTimingRef.current, 'destination receipt confirmed');

      setStatus('destination-confirmed');
      setStatus('verification-pending');
      const receiptVerified = timeArcForwardingSync(forwardingTimingRef.current, 'destination receipt verification', () => verifyDestinationReceipt({
        receiptStatus: destinationReceipt.status,
        receiptTo: destinationReceipt.to,
        expectedMessageTransmitter: destination.messageTransmitterV2,
        expectedToken: destination.usdc,
        recipient,
        expectedAmount: quote.toAmount ?? quote.fromAmount,
        logs: destinationReceipt.logs,
      }));

      if (!receiptVerified) {
        const nextError = new Error('Destination USDC verification failed: the confirmed receipt did not contain the expected canonical USDC transfer');
        setStatus('error');
        setError(nextError);
        return undefined;
      }
      setDestinationVerified(true);
      markArcForwardingTiming(forwardingTimingRef.current, 'final destination verification succeeded');

      if (sourceHash) {
        queryClient.setQueryData<BridgeStatus>(['bridge-status', quote.id, sourceHash.toString()], (current) => current ? ({
          ...current,
          receiving: { txHash: hash, chainId: quote.toChain.id },
        }) : ({
          status: 'PENDING',
          substatus: 'Destination receiveMessage submitted',
          receiving: { txHash: hash, chainId: quote.toChain.id },
        }));
      }

      setStatus('completed');
      await queryClient.invalidateQueries();
      return hash;
    } catch (caughtError) {
      recordArcForwardingFailure(forwardingTimingRef.current, 'Bridge destination completion', caughtError);
      if (isExplicitWalletRejection(caughtError)) {
        destinationSubmissionAttemptedRef.current = false;
        destinationMintRevertedRef.current = previousDestinationMintReverted;
      }
      if (destinationCompletionKeyRef.current === destinationCompletionKey) {
        destinationCompletionGuardRef.current.release(destinationCompletionKey);
        destinationCompletionKeyRef.current = null;
      }
      setStatus('error');
      setError(destinationSubmissionAttemptedRef.current && !isExplicitWalletRejection(caughtError)
        ? new Error('Destination wallet submission outcome is unknown. Check Sepolia activity before attempting recovery.')
        : caughtError instanceof Error ? caughtError : new Error('Destination mint failed'));
      return undefined;
    }
  };
  return { beginReview, execute, complete, reset, markAttestationPending, markAttestationReady, retryForwardingReconciliation, forwardingReconciliationTimedOut, status, sourceHash, destinationHash, destinationVerified, destinationSubmissionAttempted: destinationSubmissionAttemptedRef.current, destinationSubmissionReverted: destinationMintRevertedRef.current, error, quote: activeQuote };
}
