import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, usePublicClient, useSendTransaction } from 'wagmi';
import { decodeFunctionData, encodeFunctionData, pad, type Address, type EIP1193Provider, type Hash, type Hex } from 'viem';
import type { BridgeQuote, BridgeStatus } from '../types/bridge';
import { cctpMessageTransmitterAbi, cctpTokenMessengerAbi, createCctpProvider, getCctpMessageIdentity } from '../services/bridge/cctp';
import {
  CircleForwardingError,
  executeCircleForwarding,
  isCircleForwardingSupported,
  pollCircleForwardingStatus,
} from '../services/bridge/circleForwarding';
import { getOrbitNetwork } from '../data/networks';
import { createBridgeExecutionGate, resumeCctpBridgeLifecycle, runCctpBridgeLifecycle, type CctpLifecycleAdapter, type CctpLifecycleSnapshot } from '../services/bridge/lifecycle';
import { createBridgeRecoveryJournalEntry, createRecoveredCctpBridgeQuote, readLatestBridgeRecoveryJournalEntry, saveBridgeRecoveryJournalEntry, type BridgeDestinationSubmissionState, type BridgeRecoveryJournalEntry } from '../services/bridge/recoveryJournal';
import { BridgeTrackingTimeoutError, reconcileForwardingTransfer } from '../services/bridge/forwardingReconciliation';
import { verifyDestinationReceipt, verifyForwardingDestinationReceipt } from '../services/bridge/verification';
import { isSameBridgeQuoteSnapshot } from './useBridgeQuote';
import { associateBridgeQuoteTiming, beginArcForwardingTiming, markArcForwardingTiming, timeArcForwardingAwait, type ArcForwardingTiming } from '../services/bridge/arcForwardingTiming';

export type BridgeExecutionStatus =
  | 'idle'
  | 'preflight'
  | 'source-pending'
  | 'source-confirmed'
  | 'attestation-pending'
  | 'attestation-ready'
  | 'destination-pending'
  | 'completed'
  | 'needs-attention'
  | 'error'
  | 'cancelled';

export interface BridgeProgressStep {
  label: string;
  state: 'pending' | 'active' | 'complete';
}

const cctpProvider = createCctpProvider();
const RECEIPT_TIMEOUT_MS = 120_000;
const ATTESTATION_POLL_INTERVAL_MS = 3_000;
const FORWARDING_STATUS_POLL_INTERVAL_MS = 3_000;
const FORWARDING_STATUS_REQUEST_TIMEOUT_MS = 8_000;
const CCTP_ATTESTATION_MAX_POLLS = 20;

function isExplicitWalletRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === 4001 || candidate.code === '4001' ||
    (candidate.cause !== undefined && candidate.cause !== error && isExplicitWalletRejection(candidate.cause));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function getBridgeSelectedRoute(quote?: Pick<BridgeQuote, 'selectedRoute' | 'fromChain' | 'toChain'>) {
  return quote?.selectedRoute ?? (
    quote && isCircleForwardingSupported(quote.fromChain.id, quote.toChain.id)
      ? 'forwarding'
      : 'cctp'
  );
}

export function isBridgeExecutionStarted(status: BridgeExecutionStatus, sourceHash?: Hash) {
  return Boolean(sourceHash) || !['idle', 'error', 'needs-attention', 'cancelled'].includes(status);
}

export function canShowBridgeSuccess(input: { status: BridgeExecutionStatus; sourceHash?: Hash; destinationHash?: Hash; destinationVerified: boolean }) {
  return input.status === 'completed' && Boolean(input.sourceHash && input.destinationVerified);
}

export function createBridgeCompletionGate() {
  const completedSourceHashes = new Set<Hash>();
  return {
    markComplete(sourceHash: Hash) {
      if (completedSourceHashes.has(sourceHash)) return false;
      completedSourceHashes.add(sourceHash);
      return true;
    },
    isComplete(sourceHash?: Hash) {
      return Boolean(sourceHash && completedSourceHashes.has(sourceHash));
    },
  };
}

export function preserveCompletedBridgeStatus(current: BridgeExecutionStatus, next: BridgeExecutionStatus) {
  return current === 'completed' ? current : next;
}

export function shouldResetBridgeAmount(input: { status: BridgeExecutionStatus; sourceHash?: Hash; destinationHash?: Hash; destinationVerified: boolean }) {
  return canShowBridgeSuccess(input);
}

export function getCompactBridgeProgressSteps(
  status: BridgeExecutionStatus,
  _route?: BridgeQuote['selectedRoute'],
  hashes: { sourceHash?: boolean; destinationHash?: boolean; destinationVerified?: boolean } = {},
): BridgeProgressStep[] {
  const currentStep = status === 'preflight' ? 0
    : status === 'source-pending' ? 1
      : status === 'source-confirmed' || status === 'attestation-pending' || status === 'attestation-ready' || status === 'destination-pending' ? 3
        : status === 'completed' ? 4
          : (status === 'error' || status === 'needs-attention') && hashes.sourceHash ? 3
            : -1;
  const labels = ['Preparing', 'Confirm in wallet', 'Source confirmed', 'Processing transfer', 'Complete'];
  return labels.map((label, index) => ({
    label,
    state: currentStep < 0
      ? 'pending'
      : index < currentStep || status === 'completed' && index === currentStep
        ? 'complete'
        : index === currentStep
          ? 'active'
          : 'pending',
  }));
}

export function getCompactBridgeStatus(
  status: BridgeExecutionStatus,
  forwarding: boolean,
  hashes: { source?: boolean; destination?: boolean; destinationVerified?: boolean } = {},
) {
  if (status === 'preflight') return 'Preparing transfer…';
  if (status === 'source-pending') return hashes.source ? 'Source submitted; waiting for its on-chain receipt.' : 'Confirm the source transfer in your wallet.';
  if (status === 'source-confirmed' || status === 'attestation-pending') return forwarding ? 'Circle is processing the transfer.' : 'Waiting for Circle attestation.';
  if (status === 'attestation-ready') return forwarding ? 'Circle is processing the transfer.' : 'Circle attestation received. Confirm the destination mint.';
  if (status === 'destination-pending') return hashes.destination ? 'Verifying the destination mint.' : 'Confirm the destination mint in your wallet.';
  if (status === 'completed') return hashes.destinationVerified ? 'Transfer complete; destination receipt verified.' : 'Transfer complete.';
  return null;
}

export function getRequiredBridgeChainId(input: {
  status: BridgeExecutionStatus;
  sourceChainId: number;
  destinationChainId: number;
  selectedRoute?: BridgeQuote['selectedRoute'];
  sourceHash?: Hash;
  destinationHash?: Hash;
  verifiedComplete?: boolean;
  sourceActionReady?: boolean;
}) {
  if (input.verifiedComplete || input.status === 'completed') return undefined;
  if (input.sourceHash && input.selectedRoute === 'forwarding') return undefined;
  if (input.destinationHash && input.selectedRoute === 'cctp') return input.destinationChainId;
  if (input.status === 'attestation-ready' && input.sourceHash) return input.destinationChainId;
  if (!input.sourceHash && (input.status === 'idle' || input.status === 'error') && input.sourceActionReady) return input.sourceChainId;
  return undefined;
}

export function shouldShowBridgeWrongNetwork(input: { isConnected: boolean; walletChainId?: number; requiredChainId?: number }) {
  return input.isConnected && input.requiredChainId !== undefined && input.walletChainId !== input.requiredChainId;
}

export function shouldShowBridgeSourceConfirmation(input: { open: boolean; executionStarted: boolean; sourceHash?: Hash }) {
  return input.open && !input.executionStarted && !input.sourceHash;
}

export function shouldShowCctpDestinationMintAction(input: {
  selectedRoute?: BridgeQuote['selectedRoute'];
  status?: BridgeStatus['status'];
  message?: Hex;
  attestation?: Hex;
}) {
  return input.selectedRoute === 'cctp' && input.status === 'DONE' && Boolean(input.message && input.attestation);
}

export function shouldResetBridgeExecution(input: {
  status?: BridgeExecutionStatus;
  sourceHash?: Hash;
  sourceSubmissionAttempted?: boolean;
  routeChanged: boolean;
  amountChanged: boolean;
  accountChanged: boolean;
  sourceNetworkChanged: boolean;
}) {
  return !input.sourceSubmissionAttempted &&
    !isBridgeExecutionStarted(input.status ?? 'idle', input.sourceHash) &&
    (input.routeChanged || input.amountChanged || input.accountChanged || input.sourceNetworkChanged);
}

function getError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

function waitForBridgePollingInterval() {
  return new Promise<void>((resolve) => setTimeout(resolve, FORWARDING_STATUS_POLL_INTERVAL_MS));
}

function createCctpAttestationAdapter(quote: BridgeQuote, timing?: ArcForwardingTiming): Pick<CctpLifecycleAdapter, 'pollAttestation' | 'waitBeforeNextPoll'> {
  return {
    pollAttestation: async (hash) => {
      const result = await timeArcForwardingAwait(
        timing,
        'Circle CCTP attestation poll',
        () => cctpProvider.getStatus(quote, hash),
      );
      if (result.status === 'PENDING') markArcForwardingTiming(timing, 'Circle CCTP attestation pending');
      if (result.status === 'DONE') markArcForwardingTiming(timing, 'Circle CCTP attestation ready');
      if (result.status === 'FAILED') markArcForwardingTiming(timing, 'Circle CCTP attestation failed');
      if (result.status === 'DONE' && result.message) {
        const source = getOrbitNetwork(quote.fromChain.id);
        const destination = getOrbitNetwork(quote.toChain.id);
        if (!source || !destination) throw new Error('The selected CCTP route is unavailable.');
        getCctpMessageIdentity(result.message, {
          sourceDomain: source.cctpDomain,
          destinationDomain: destination.cctpDomain,
          sourceTokenMessenger: source.tokenMessengerV2,
          destinationTokenMessenger: destination.tokenMessengerV2,
        });
      }
      return result;
    },
    waitBeforeNextPoll: () => new Promise<void>((resolve) => setTimeout(resolve, ATTESTATION_POLL_INTERVAL_MS)),
  };
}

async function verifyCctpSourceTransaction(
  client: NonNullable<ReturnType<typeof usePublicClient>> | undefined,
  entry: BridgeRecoveryJournalEntry,
  quote: BridgeQuote,
  timing?: ArcForwardingTiming,
) {
  const source = getOrbitNetwork(entry.sourceChainId);
  const destination = getOrbitNetwork(entry.destinationChainId);
  if (!client || !source || !destination) throw new Error('The saved CCTP source network is unavailable.');
  const chainId = await timeArcForwardingAwait(timing, 'recovery source chain validation', () => client.getChainId());
  if (chainId !== entry.sourceChainId) throw new Error('The saved source transaction belongs to a different network.');
  const transaction = await timeArcForwardingAwait(timing, 'recovery source transaction lookup', () =>
    client.getTransaction({ hash: entry.sourceHash }),
  );
  const expectedTarget = entry.sourceTarget ?? source.tokenMessengerV2;
  const expectedRecipient = entry.recipientAddress ?? entry.walletAddress;
  if (
    transaction.hash.toLowerCase() !== entry.sourceHash.toLowerCase() ||
    transaction.from.toLowerCase() !== entry.walletAddress.toLowerCase() ||
    transaction.to?.toLowerCase() !== source.tokenMessengerV2.toLowerCase() ||
    expectedTarget.toLowerCase() !== source.tokenMessengerV2.toLowerCase()
  ) {
    throw new Error('The saved source transaction does not match this wallet and CCTP route.');
  }
  const decoded = decodeFunctionData({ abi: cctpTokenMessengerAbi, data: transaction.input });
  if (decoded.functionName !== 'depositForBurn') throw new Error('The saved source transaction is not a CCTP burn.');
  const [amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold] = decoded.args;
  if (
    amount !== quote.fromAmount ||
    destinationDomain !== destination.cctpDomain ||
    mintRecipient.toLowerCase() !== pad(expectedRecipient, { size: 32 }).toLowerCase() ||
    burnToken.toLowerCase() !== source.usdc.toLowerCase() ||
    destinationCaller.toLowerCase() !== `0x${'0'.repeat(64)}` ||
    maxFee !== 0n ||
    minFinalityThreshold !== 2000
  ) {
    throw new Error('The saved source transaction calldata does not match the expected CCTP route, amount, recipient, or fee policy.');
  }
  const receipt = await timeArcForwardingAwait(timing, 'recovery source receipt lookup', () =>
    client.getTransactionReceipt({ hash: entry.sourceHash }),
  );
  if (
    receipt.transactionHash.toLowerCase() !== entry.sourceHash.toLowerCase() ||
    receipt.status !== 'success' ||
    receipt.to?.toLowerCase() !== source.tokenMessengerV2.toLowerCase()
  ) {
    throw new Error('The saved CCTP source transaction has not been confirmed successfully.');
  }
}

async function reconcileForwardingUntilComplete(input: {
  quote: BridgeQuote;
  sourceHash: Hash;
  destinationHashHint?: Hash;
  recipient: Address;
  expectedNetAmount: bigint;
  sourceClient?: NonNullable<ReturnType<typeof usePublicClient>>;
  destinationClient?: NonNullable<ReturnType<typeof usePublicClient>>;
  onDestinationHash?: (hash: Hash) => void;
}): Promise<{ sourceHash: Hash; destinationHash: Hash }> {
  const destinationNetwork = getOrbitNetwork(input.quote.toChain.id);
  if (!destinationNetwork) throw new Error('The selected forwarding destination is unavailable.');

  return reconcileForwardingTransfer(input.sourceHash, {
    verifySourceReceipt: async (hash) => {
      if (!input.sourceClient) throw new BridgeTrackingTimeoutError('The source network RPC is unavailable to verify the transaction.');
      try {
        const receipt = await withTimeout(
          input.sourceClient.waitForTransactionReceipt({ hash }),
          RECEIPT_TIMEOUT_MS,
          'The source transaction receipt could not be verified before the timeout.',
        );
        return receipt.status === 'success';
      } catch (caughtError) {
        if (caughtError instanceof BridgeTrackingTimeoutError) throw caughtError;
        throw new BridgeTrackingTimeoutError(
          `The source transaction receipt could not be verified: ${getError(caughtError, 'Source receipt lookup failed.').message}`,
        );
      }
    },
    pollStatus: async (hash) => {
      const status = await pollCircleForwardingStatus({
        sourceChainId: input.quote.fromChain.id,
        sourceHash: hash,
        recipient: input.recipient,
        timeoutMs: FORWARDING_STATUS_REQUEST_TIMEOUT_MS,
        pollingConfig: { timeout: 5_000, maxRetries: 1, retryDelay: 1_000 },
      });
      return status ?? undefined;
    },
    verifyDestinationReceipt: async (hash) => {
      if (!input.destinationClient) throw new BridgeTrackingTimeoutError('The destination network RPC is unavailable to verify the transfer.');
      let receipt;
      try {
        receipt = await withTimeout(
          input.destinationClient.getTransactionReceipt({ hash }),
          FORWARDING_STATUS_REQUEST_TIMEOUT_MS,
          'The destination receipt lookup timed out.',
        );
      } catch {
        return false;
      }
      if (receipt.status === 'reverted') return 'failed';
      return verifyForwardingDestinationReceipt({
        receiptStatus: receipt.status,
        expectedToken: destinationNetwork.usdc,
        recipient: input.recipient,
        expectedAmount: input.expectedNetAmount,
        logs: receipt.logs,
      });
    },
    waitBeforeNextPoll: waitForBridgePollingInterval,
  }, {
    destinationHashHint: input.destinationHashHint,
    onDestinationHash: input.onDestinationHash,
  });
}

export function useBridgeExecution(quote: BridgeQuote | undefined) {
  const { address, chainId, connector } = useAccount();
  const recoveryRead = useMemo(
    () => address ? readLatestBridgeRecoveryJournalEntry(address) : {},
    [address],
  );
  const recoveryEntry = recoveryRead.entry;
  const [dismissedRecoveryKey, setDismissedRecoveryKey] = useState<string | null>(null);
  const recoveryKey = recoveryEntry
    ? `${recoveryEntry.walletAddress.toLowerCase()}:${recoveryEntry.sourceHash.toLowerCase()}`
    : null;
  const activeRecoveryEntry = recoveryKey && recoveryKey !== dismissedRecoveryKey ? recoveryEntry : undefined;
  const sourceClient = usePublicClient({ chainId: activeRecoveryEntry?.sourceChainId ?? quote?.fromChain.id });
  const destinationClient = usePublicClient({ chainId: activeRecoveryEntry?.destinationChainId ?? quote?.toChain.id });
  const { sendTransactionAsync } = useSendTransaction();
  const [status, setStatus] = useState<BridgeExecutionStatus>('idle');
  const [sourceHash, setSourceHash] = useState<Hash>();
  const [destinationHash, setDestinationHash] = useState<Hash>();
  const [destinationVerified, setDestinationVerified] = useState(false);
  const [destinationSubmissionAttempted, setDestinationSubmissionAttempted] = useState(false);
  const [destinationSubmissionState, setDestinationSubmissionState] = useState<BridgeDestinationSubmissionState>('not-submitted');
  const [sourceSubmissionAttempted, setSourceSubmissionAttempted] = useState(false);
  const [sourceReceiptConfirmed, setSourceReceiptConfirmed] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>();
  const [error, setError] = useState<Error | null>(null);
  const [recoverySaveError, setRecoverySaveError] = useState<Error | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const executionGateRef = useRef(createBridgeExecutionGate());
  const destinationRunLockRef = useRef(false);
  const cctpAttestationRetryRef = useRef(false);
  const cctpSourceReceiptRetryRef = useRef(false);
  const sourceHashRef = useRef<Hash>();
  const cctpSourceConfirmedRef = useRef(false);
  const destinationHashRef = useRef<Hash>();
  const destinationSubmissionAttemptedRef = useRef(false);
  const destinationSubmissionStateRef = useRef<BridgeDestinationSubmissionState>('not-submitted');
  const executionQuoteRef = useRef<BridgeQuote>();
  const forwardingRecoveryActiveRef = useRef(false);
  const executionRunIdRef = useRef(0);
  const completionGateRef = useRef(createBridgeCompletionGate());
  const executionWalletRef = useRef<Address>();
  const restoredRecoveryKeyRef = useRef<string | null>(null);
  const recoveryTimingRef = useRef<ArcForwardingTiming>();

  useEffect(() => {
    if (recoveryRead.error) setError(recoveryRead.error);
  }, [recoveryRead.error]);

  useEffect(() => {
    const entry = activeRecoveryEntry;
    if (!address || !entry) return;
    const recoveryKey = `${entry.walletAddress.toLowerCase()}:${entry.sourceHash.toLowerCase()}`;
    if (restoredRecoveryKeyRef.current === recoveryKey) return;
    const recoveredQuote = createRecoveredCctpBridgeQuote(entry);
    if (!recoveredQuote) {
      setError(new Error('The saved Bridge recovery route is no longer valid and cannot be resumed safely.'));
      return;
    }
    restoredRecoveryKeyRef.current = recoveryKey;

    executionWalletRef.current = entry.walletAddress;
    executionQuoteRef.current = recoveredQuote;
    sourceHashRef.current = entry.sourceHash;
    destinationHashRef.current = entry.destinationHash;
    executionGateRef.current.markSourceSubmitted();
    completionGateRef.current = createBridgeCompletionGate();
    const restoredDestinationState = entry.destinationHash
      ? entry.destinationSubmissionState === 'confirmed' ? 'confirmed' : 'submitted'
      : entry.destinationSubmissionState === 'submission-pending' ||
          entry.destinationSubmissionState === 'submission-unknown' ||
          entry.destinationSubmissionState === undefined && (entry.status === 'destination-pending' || entry.status === 'error')
        ? 'submission-unknown'
        : 'not-submitted';
    destinationSubmissionStateRef.current = restoredDestinationState;
    destinationSubmissionAttemptedRef.current = restoredDestinationState !== 'not-submitted';
    const recoveryTiming = beginArcForwardingTiming('Bridge recovery resumed');
    recoveryTimingRef.current = recoveryTiming;
    associateBridgeQuoteTiming(recoveredQuote, recoveryTiming);
    setSourceHash(entry.sourceHash);
    setDestinationHash(entry.destinationHash);
    setSourceSubmissionAttempted(true);
    setDestinationSubmissionAttempted(restoredDestinationState !== 'not-submitted');
    setDestinationSubmissionState(restoredDestinationState);
    if (restoredDestinationState !== entry.destinationSubmissionState) {
      const saveError = saveBridgeRecoveryJournalEntry({
        ...entry,
        destinationSubmissionState: restoredDestinationState,
        updatedAt: Date.now(),
      });
      setRecoverySaveError(saveError);
    }
    setStatus('needs-attention');
    setIsSubmitting(true);
    setError(null);
    setBridgeStatus(undefined);
    setDestinationVerified(false);
    setSourceReceiptConfirmed(false);

    let active = true;
    void verifyCctpSourceTransaction(sourceClient, entry, recoveredQuote, recoveryTimingRef.current)
      .then(() => {
        if (!active || executionWalletRef.current?.toLowerCase() !== entry.walletAddress.toLowerCase()) return;
        cctpSourceConfirmedRef.current = true;
        setSourceReceiptConfirmed(true);
        setError(new Error('Saved source receipt verified. Retry Circle attestation to continue.'));
      })
      .catch((caughtError: unknown) => {
        if (!active || executionWalletRef.current?.toLowerCase() !== entry.walletAddress.toLowerCase()) return;
        cctpSourceConfirmedRef.current = false;
        setError(getError(caughtError, 'Saved source transaction receipt could not be verified.'));
      })
      .finally(() => {
        if (active) setIsSubmitting(false);
      });
    return () => {
      active = false;
      if (restoredRecoveryKeyRef.current === recoveryKey) restoredRecoveryKeyRef.current = null;
    };
  }, [activeRecoveryEntry, address, sourceClient]);

  const continueForwardingVerification = async (input: {
    runId: number;
    quote: BridgeQuote;
    sourceHash: Hash;
    destinationHashHint?: Hash;
    recipient: Address;
    expectedNetAmount: bigint;
  }) => {
    if (forwardingRecoveryActiveRef.current) return;
    forwardingRecoveryActiveRef.current = true;
    try {
      while (executionRunIdRef.current === input.runId && sourceHashRef.current === input.sourceHash && !completionGateRef.current.isComplete(input.sourceHash)) {
        try {
          const forwarding = await reconcileForwardingUntilComplete({
            ...input,
            sourceClient,
            destinationClient,
            onDestinationHash: (hash) => publishDestinationHash(hash, input.runId),
          });
          if (sourceHashRef.current !== input.sourceHash || executionRunIdRef.current !== input.runId) return;
          completeVerifiedBridge(input.runId, forwarding.sourceHash, forwarding.destinationHash);
          return;
        } catch (caughtError) {
          if (sourceHashRef.current !== input.sourceHash || executionRunIdRef.current !== input.runId || completionGateRef.current.isComplete(input.sourceHash)) return;
          const lastCheck = getError(caughtError, 'Destination verification is not available yet.').message;
          const stillProcessing = new BridgeTrackingTimeoutError(
            `Still processing. The source transaction is preserved, and destination verification will continue automatically. ${lastCheck}`,
          );
          setError(stillProcessing);
          setExecutionStatus(input.runId, 'needs-attention');
          persistRecovery('needs-attention', stillProcessing.message);
          await waitForBridgePollingInterval();
        }
      }
    } finally {
      forwardingRecoveryActiveRef.current = false;
    }
  };

  const persistRecovery = (
    statusValue: BridgeExecutionStatus,
    errorMessage?: string,
    destinationState = destinationSubmissionStateRef.current,
  ): Error | null => {
    const activeQuote = executionQuoteRef.current;
    const hash = sourceHashRef.current;
    const recoveryWallet = executionWalletRef.current ?? address;
    if (!activeQuote || !recoveryWallet || !hash) return null;
    try {
      const entry = createBridgeRecoveryJournalEntry(
        activeQuote,
        recoveryWallet,
        hash,
        statusValue === 'idle' ? 'error' : statusValue,
        {
          ...(destinationHashRef.current ? { destinationHash: destinationHashRef.current } : {}),
          destinationSubmissionState: destinationState,
          ...(errorMessage ? { error: errorMessage } : {}),
        },
      );
      const saveError = saveBridgeRecoveryJournalEntry(entry);
      setRecoverySaveError(saveError);
      return saveError;
    } catch (caughtError) {
      const saveError = getError(caughtError, 'Bridge recovery details could not be saved.');
      setRecoverySaveError(saveError);
      return saveError;
    }
  };

  const setExecutionStatus = (runId: number, nextStatus: BridgeExecutionStatus) => {
    if (runId !== executionRunIdRef.current || completionGateRef.current.isComplete(sourceHashRef.current)) return;
    setStatus((current) => preserveCompletedBridgeStatus(current, nextStatus));
  };

  const publishSourceHash = (hash: Hash, runId = executionRunIdRef.current) => {
    if (runId !== executionRunIdRef.current || completionGateRef.current.isComplete(hash)) return;
    sourceHashRef.current = hash;
    setSourceHash(hash);
    persistRecovery('source-pending');
  };
  const publishDestinationHash = (hash: Hash, runId = executionRunIdRef.current) => {
    if (runId !== executionRunIdRef.current || completionGateRef.current.isComplete(sourceHashRef.current)) return;
    destinationHashRef.current = hash;
    setDestinationHash(hash);
    persistRecovery('destination-pending');
  };
  const applyLifecycleSnapshot = (snapshot: CctpLifecycleSnapshot, runId: number) => {
    if (runId !== executionRunIdRef.current || completionGateRef.current.isComplete(sourceHashRef.current)) return;
    const nextStatus = snapshot.status === 'preparing' ? 'preflight' : snapshot.status;
    setExecutionStatus(runId, nextStatus);
    if (snapshot.sourceHash) publishSourceHash(snapshot.sourceHash, runId);
    if (snapshot.bridgeStatus) setBridgeStatus(snapshot.bridgeStatus);
    persistRecovery(nextStatus);
  };

  const completeVerifiedBridge = (runId: number, sourceHash: Hash, destinationHash: Hash) => {
    if (
      runId !== executionRunIdRef.current ||
      sourceHashRef.current && sourceHashRef.current !== sourceHash ||
      !completionGateRef.current.markComplete(sourceHash)
    ) return false;
    sourceHashRef.current = sourceHash;
    destinationHashRef.current = destinationHash;
    setSourceHash(sourceHash);
    setDestinationHash(destinationHash);
    setBridgeStatus({
      status: 'DONE',
      receiving: { txHash: destinationHash, chainId: (executionQuoteRef.current ?? quote)?.toChain.id },
      sending: { txHash: sourceHash, chainId: (executionQuoteRef.current ?? quote)?.fromChain.id },
    });
    setDestinationVerified(true);
    setError(null);
    setStatus('completed');
    persistRecovery('completed');
    return true;
  };

  const execute = async (timing?: ArcForwardingTiming, reviewedQuote?: BridgeQuote) => {
    if (
      sourceHashRef.current ||
      executionGateRef.current.isActive() ||
      executionGateRef.current.hasSubmittedSource() ||
      !quote ||
      !address
    ) return;
    if (
      reviewedQuote &&
      (!isSameBridgeQuoteSnapshot(quote, reviewedQuote) || Date.now() - reviewedQuote.quotedAt > 30_000)
    ) {
      setError(new Error('The reviewed Bridge quote changed or expired. Review the current route again.'));
      return;
    }
    if (chainId !== quote.fromChain.id) {
      setError(new Error(`Switch to ${quote.fromChain.name} before starting the Bridge.`));
      return;
    }
    const selectedRoute = getBridgeSelectedRoute(quote);
    if (selectedRoute !== 'forwarding' && (!quote.transactionTarget || !quote.transactionData || !sourceClient)) {
      setError(new Error('The selected Bridge route has incomplete transaction data.'));
      return;
    }
    if (!executionGateRef.current.begin()) return;
    const runId = ++executionRunIdRef.current;
    setIsSubmitting(true);
    executionQuoteRef.current = quote;
    executionWalletRef.current = address;
    recoveryTimingRef.current = undefined;
    setError(null);
    cctpSourceConfirmedRef.current = false;
    setSourceReceiptConfirmed(false);
    setBridgeStatus(undefined);
    setDestinationHash(undefined);
    destinationHashRef.current = undefined;
    setDestinationVerified(false);
    setDestinationSubmissionAttempted(false);
    destinationSubmissionAttemptedRef.current = false;
    setExecutionStatus(runId, 'preflight');
    let forwardingReconciliationStarted = false;
    let cctpAttestationFailed = false;

    try {
      if (selectedRoute === 'forwarding') {
        if (!connector) throw new Error('Connect a wallet to start Circle forwarding.');
        const provider = await connector.getProvider() as EIP1193Provider;
        const rawQuote = quote.raw && typeof quote.raw === 'object' && 'quote' in quote.raw
          ? (quote.raw as { quote?: unknown }).quote
          : undefined;
        executionGateRef.current.markSourceSubmitted();
        setSourceSubmissionAttempted(true);
        const forwardingExecution = executeCircleForwarding({
            provider,
            sourceChainId: quote.fromChain.id,
            destinationChainId: quote.toChain.id,
            sourceAddress: address,
            recipient: quote.recipientAddress ?? address,
            amount: quote.fromAmount,
            quote: rawQuote,
            destinationAmount: quote.toAmount ?? undefined,
            totalSourceDebit: quote.totalSourceDebit ?? undefined,
            onStep: (step) => {
              if (runId !== executionRunIdRef.current || completionGateRef.current.isComplete(sourceHashRef.current)) return;
              const normalizedStep = step.name.toLowerCase();
              if (normalizedStep === 'burn' && step.txHash) {
                publishSourceHash(step.txHash as Hash, runId);
                setExecutionStatus(runId, step.state === 'success' ? 'source-confirmed' : 'source-pending');
              } else if (normalizedStep === 'fetchattestation' && step.state === 'pending') {
                setExecutionStatus(runId, 'attestation-pending');
              } else if (normalizedStep === 'fetchattestation' && step.state === 'success') {
                setExecutionStatus(runId, 'attestation-ready');
              } else if (normalizedStep === 'mint' && step.txHash) {
                publishDestinationHash(step.txHash as Hash, runId);
                setExecutionStatus(runId, 'destination-pending');
              }
            },
          });
        const result = await forwardingExecution;
        publishSourceHash(result.sourceHash, runId);
        if (result.destinationHash) publishDestinationHash(result.destinationHash, runId);
        setExecutionStatus(runId, result.destinationHash ? 'destination-pending' : 'source-confirmed');
        persistRecovery(result.destinationHash ? 'destination-pending' : 'source-confirmed');
        forwardingReconciliationStarted = true;
        const forwarding = await reconcileForwardingUntilComplete({
          quote,
          sourceHash: result.sourceHash,
          destinationHashHint: result.destinationHash,
          recipient: quote.recipientAddress ?? address,
          expectedNetAmount: quote.toAmount ?? quote.fromAmount,
          sourceClient,
          destinationClient,
          onDestinationHash: (hash) => publishDestinationHash(hash, runId),
        });
        completeVerifiedBridge(runId, forwarding.sourceHash, forwarding.destinationHash);
      } else {
        const cctpAdapter: CctpLifecycleAdapter = {
          submitSource: async () => {
            if (executionGateRef.current.hasSubmittedSource() && sourceHashRef.current) {
              throw new Error('The source transaction was already submitted. It will not be submitted again.');
            }
            executionGateRef.current.markSourceSubmitted();
            setSourceSubmissionAttempted(true);
            const hash = await sendTransactionAsync({
              to: quote.transactionTarget!,
              data: quote.transactionData!,
              value: quote.transactionValue,
              chainId: quote.fromChain.id,
            });
            publishSourceHash(hash);
            return hash;
          },
          waitForSource: async (hash) => {
            if (!sourceClient) throw new Error('The source network RPC is unavailable.');
            const receipt = await withTimeout(
              sourceClient.waitForTransactionReceipt({ hash }),
              RECEIPT_TIMEOUT_MS,
              'Source receipt check timed out. The source transaction will not be resubmitted.',
            );
            if (receipt.status !== 'success' || receipt.to?.toLowerCase() !== quote.transactionTarget?.toLowerCase()) {
              throw new Error('The source transaction did not confirm against the quoted Bridge contract.');
            }
            cctpSourceConfirmedRef.current = true;
          },
          ...createCctpAttestationAdapter(quote, timing),
        };
        await runCctpBridgeLifecycle(
          cctpAdapter,
          (snapshot) => {
            if (snapshot.bridgeStatus?.status === 'FAILED') cctpAttestationFailed = true;
            applyLifecycleSnapshot(snapshot, runId);
          },
          CCTP_ATTESTATION_MAX_POLLS,
        );
      }
    } catch (caughtError) {
      if (runId !== executionRunIdRef.current || completionGateRef.current.isComplete(sourceHashRef.current)) return;
      if (isExplicitWalletRejection(caughtError) && !sourceHashRef.current) {
        executionGateRef.current.releaseWalletRejection();
        setSourceSubmissionAttempted(false);
        setSourceReceiptConfirmed(false);
      }
      if (caughtError instanceof CircleForwardingError && caughtError.sourceHash) {
        publishSourceHash(caughtError.sourceHash, runId);
        if (caughtError.destinationHash) publishDestinationHash(caughtError.destinationHash, runId);
      }
      let reportedError = caughtError;
      if (!forwardingReconciliationStarted && selectedRoute === 'forwarding' && sourceHashRef.current) {
        forwardingReconciliationStarted = true;
        try {
          const forwarding = await reconcileForwardingUntilComplete({
            quote,
            sourceHash: sourceHashRef.current,
            destinationHashHint: caughtError instanceof CircleForwardingError ? caughtError.destinationHash : destinationHashRef.current,
            recipient: quote.recipientAddress ?? address,
            expectedNetAmount: quote.toAmount ?? quote.fromAmount,
            sourceClient,
            destinationClient,
            onDestinationHash: (hash) => publishDestinationHash(hash, runId),
          });
          completeVerifiedBridge(runId, forwarding.sourceHash, forwarding.destinationHash);
          return;
        } catch (reconciliationError) {
          reportedError = reconciliationError;
        }
      }
      if (selectedRoute === 'forwarding' && sourceHashRef.current && reportedError instanceof BridgeTrackingTimeoutError) {
        const stillProcessing = new BridgeTrackingTimeoutError(
          'Still processing. The source transaction is preserved, and destination verification will continue automatically.',
        );
        setError(stillProcessing);
        setExecutionStatus(runId, 'needs-attention');
        persistRecovery('needs-attention', stillProcessing.message);
        void continueForwardingVerification({
          runId,
          quote,
          sourceHash: sourceHashRef.current,
          destinationHashHint: destinationHashRef.current,
          recipient: quote.recipientAddress ?? address,
          expectedNetAmount: quote.toAmount ?? quote.fromAmount,
        });
        return;
      }
      const nextError = getError(reportedError, 'Bridge transfer could not be verified.');
      setError(nextError);
      const canResumeCctp = selectedRoute === 'cctp' &&
        cctpSourceConfirmedRef.current &&
        !cctpAttestationFailed;
      const nextStatus = reportedError instanceof BridgeTrackingTimeoutError || canResumeCctp
        ? 'needs-attention'
        : 'error';
      setExecutionStatus(runId, nextStatus);
      persistRecovery(nextStatus, nextError.message);
    } finally {
      executionGateRef.current.finish();
      setIsSubmitting(false);
    }
  };

  const retryCctpSourceReceipt = async (timing?: ArcForwardingTiming) => {
    const activeQuote = executionQuoteRef.current;
    const hash = sourceHashRef.current;
    const wallet = executionWalletRef.current ?? address;
    const entry = activeRecoveryEntry?.sourceHash.toLowerCase() === hash?.toLowerCase()
      ? activeRecoveryEntry
      : activeQuote && wallet && hash
        ? createBridgeRecoveryJournalEntry(activeQuote, wallet, hash, 'source-pending')
        : undefined;
    if (
      !activeQuote ||
      !entry ||
      entry.sourceHash.toLowerCase() !== hash?.toLowerCase() ||
      entry.walletAddress.toLowerCase() !== address?.toLowerCase() ||
      getBridgeSelectedRoute(activeQuote) !== 'cctp' ||
      !hash ||
      cctpSourceConfirmedRef.current ||
      cctpSourceReceiptRetryRef.current ||
      cctpAttestationRetryRef.current ||
      executionGateRef.current.isActive() ||
      isSubmitting
    ) return;

    cctpSourceReceiptRetryRef.current = true;
    setIsSubmitting(true);
    setError(null);
    const activeTiming = timing ?? recoveryTimingRef.current;
    try {
      await verifyCctpSourceTransaction(sourceClient, entry, activeQuote, activeTiming);
      if (sourceHashRef.current !== hash || executionWalletRef.current?.toLowerCase() !== address?.toLowerCase()) return;
      cctpSourceConfirmedRef.current = true;
      setSourceReceiptConfirmed(true);
      setError(new Error('Saved source receipt verified. Retry Circle attestation to continue.'));
      setStatus('needs-attention');
      persistRecovery('needs-attention');
    } catch (caughtError) {
      if (sourceHashRef.current !== hash) return;
      const nextError = getError(caughtError, 'The saved source receipt could not be verified.');
      setError(nextError);
      setStatus('needs-attention');
      persistRecovery('needs-attention', nextError.message);
    } finally {
      cctpSourceReceiptRetryRef.current = false;
      setIsSubmitting(false);
    }
  };

  const retryCctpAttestation = async (timing?: ArcForwardingTiming) => {
    const activeQuote = executionQuoteRef.current ?? quote;
    const hash = sourceHashRef.current;
    if (
      !activeQuote ||
      getBridgeSelectedRoute(activeQuote) !== 'cctp' ||
      !hash ||
      !cctpSourceConfirmedRef.current ||
      executionWalletRef.current?.toLowerCase() !== address?.toLowerCase() ||
      bridgeStatus?.status === 'FAILED' ||
      executionGateRef.current.isActive() ||
      cctpAttestationRetryRef.current ||
      status === 'completed' ||
      isSubmitting
    ) return;

    cctpAttestationRetryRef.current = true;
    const runId = ++executionRunIdRef.current;
    executionQuoteRef.current = activeQuote;
    setIsSubmitting(true);
    setError(null);
    setExecutionStatus(runId, 'attestation-pending');
    setBridgeStatus(undefined);
    persistRecovery('attestation-pending');
    let attestationFailed = false;
    try {
      const attestation = await resumeCctpBridgeLifecycle(
        hash,
        createCctpAttestationAdapter(activeQuote, timing ?? recoveryTimingRef.current),
        (snapshot) => {
          if (snapshot.bridgeStatus?.status === 'FAILED') attestationFailed = true;
          applyLifecycleSnapshot(snapshot, runId);
        },
        CCTP_ATTESTATION_MAX_POLLS,
      );
      if (runId !== executionRunIdRef.current || sourceHashRef.current !== hash) return;
      setBridgeStatus(attestation);
      setError(null);
      setExecutionStatus(runId, 'attestation-ready');
      persistRecovery('attestation-ready');
    } catch (caughtError) {
      if (runId !== executionRunIdRef.current || sourceHashRef.current !== hash) return;
      const nextError = getError(caughtError, 'Circle attestation could not be verified.');
      setBridgeStatus((current) => current?.status === 'FAILED' ? current : undefined);
      setError(nextError);
      const nextStatus = attestationFailed ? 'error' : 'needs-attention';
      setExecutionStatus(runId, nextStatus);
      persistRecovery(nextStatus, nextError.message);
    } finally {
      cctpAttestationRetryRef.current = false;
      if (runId === executionRunIdRef.current) setIsSubmitting(false);
    }
  };

  const complete = async (message: Hex, attestation: Hex) => {
    const runId = executionRunIdRef.current;
    const activeQuote = executionQuoteRef.current ?? quote;
    const source = activeQuote && getOrbitNetwork(activeQuote.fromChain.id);
    const destination = activeQuote && getOrbitNetwork(activeQuote.toChain.id);
    if (
      !destinationHashRef.current &&
      destinationSubmissionStateRef.current !== 'not-submitted'
    ) {
      throw new Error('A previous destination mint submission may have been broadcast. Reconcile destination wallet activity; this recovery will not submit another mint.');
    }
    if (
      !activeQuote ||
      !address ||
      executionWalletRef.current?.toLowerCase() !== address.toLowerCase() ||
      !source ||
      !destination ||
      !sourceHashRef.current ||
      !destinationClient ||
      destinationRunLockRef.current ||
      status !== 'attestation-ready' && !(destinationHashRef.current && status === 'error')
    ) throw new Error('The destination mint is not ready to submit.');
    if (chainId !== activeQuote.toChain.id) throw new Error(`Switch to ${activeQuote.toChain.name} before confirming the destination mint.`);
    const identity = getCctpMessageIdentity(message, {
      sourceDomain: source.cctpDomain,
      destinationDomain: destination.cctpDomain,
      sourceTokenMessenger: source.tokenMessengerV2,
      destinationTokenMessenger: destination.tokenMessengerV2,
    });
    const data = encodeFunctionData({
      abi: cctpMessageTransmitterAbi,
      functionName: 'receiveMessage',
      args: [message, attestation],
    });
    const mintTarget = destination.messageTransmitterV2;
    destinationRunLockRef.current = true;
    setIsSubmitting(true);
    setExecutionStatus(runId, 'destination-pending');
    setError(null);
    if (destinationHashRef.current) {
      persistRecovery('destination-pending');
    }
    let walletSubmissionStarted = false;
    try {
      let hash = destinationHashRef.current;
      if (hash) {
        markArcForwardingTiming(recoveryTimingRef.current, 'destination mint receipt retry');
      } else {
        const gas = await destinationClient.estimateGas({ account: address, to: mintTarget, data });
        const [gasPrice, balance] = await Promise.all([
          destinationClient.getGasPrice(),
          destinationClient.getBalance({ address }),
        ]);
        if (balance < gas * gasPrice) {
          throw new Error(`Insufficient ${destination.nativeCurrency.symbol} for the destination mint gas.`);
        }
        destinationSubmissionStateRef.current = 'submission-pending';
        setDestinationSubmissionState('submission-pending');
        const saveError = persistRecovery('destination-pending', undefined, 'submission-pending');
        if (saveError) {
          destinationSubmissionStateRef.current = 'not-submitted';
          setDestinationSubmissionState('not-submitted');
          throw new Error(`Destination mint was not submitted because its recovery state could not be saved: ${saveError.message}`);
        }
        walletSubmissionStarted = true;
        hash = await sendTransactionAsync({ to: mintTarget, data, chainId: activeQuote.toChain.id });
        destinationSubmissionStateRef.current = 'submitted';
        setDestinationSubmissionState('submitted');
        destinationSubmissionAttemptedRef.current = true;
        setDestinationSubmissionAttempted(true);
        publishDestinationHash(hash);
        persistRecovery('destination-pending', undefined, 'submitted');
      }
      const transaction = await timeArcForwardingAwait(
        recoveryTimingRef.current,
        'destination mint transaction lookup',
        () => destinationClient.getTransaction({ hash }),
      );
      if (
        transaction.hash.toLowerCase() !== hash.toLowerCase() ||
        transaction.from.toLowerCase() !== address.toLowerCase() ||
        transaction.to?.toLowerCase() !== mintTarget.toLowerCase() ||
        transaction.input.toLowerCase() !== data.toLowerCase()
      ) {
        throw new Error('The saved destination transaction does not match this wallet and CCTP mint.');
      }
      const receipt = await withTimeout(
        timeArcForwardingAwait(
          recoveryTimingRef.current,
          'destination mint receipt lookup',
          () => destinationClient.getTransactionReceipt({ hash }),
        ),
        RECEIPT_TIMEOUT_MS,
        'Destination receipt check timed out. The source transaction will not be resubmitted.',
      );
      const verified = verifyDestinationReceipt({
        receiptStatus: receipt.status,
        receiptTo: receipt.to,
        expectedMessageTransmitter: destination.messageTransmitterV2,
        expectedToken: destination.usdc,
        recipient: activeQuote.recipientAddress ?? address,
        expectedAmount: activeQuote.toAmount ?? activeQuote.fromAmount,
        requireExactAmount: activeQuote.feePayment === 'source',
        expectedMessageIdentity: identity,
        logs: receipt.logs,
      });
      if (
        receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        receipt.status !== 'success' ||
        receipt.to?.toLowerCase() !== mintTarget.toLowerCase() ||
        !verified
      ) throw new Error('The destination receipt did not verify the expected CCTP message and USDC transfer.');
      destinationSubmissionStateRef.current = 'confirmed';
      setDestinationSubmissionState('confirmed');
      persistRecovery('completed', undefined, 'confirmed');
      completeVerifiedBridge(runId, sourceHashRef.current, hash);
    } catch (caughtError) {
      if (completionGateRef.current.isComplete(sourceHashRef.current)) return;
      if (!destinationHashRef.current && isExplicitWalletRejection(caughtError)) {
        destinationSubmissionStateRef.current = 'not-submitted';
        setDestinationSubmissionState('not-submitted');
        destinationSubmissionAttemptedRef.current = false;
        setDestinationSubmissionAttempted(false);
        setExecutionStatus(runId, 'attestation-ready');
        persistRecovery('attestation-ready', undefined, 'not-submitted');
      } else if (!destinationHashRef.current && destinationSubmissionStateRef.current === 'submission-pending') {
        if (walletSubmissionStarted) {
          destinationSubmissionStateRef.current = 'submission-unknown';
          setDestinationSubmissionState('submission-unknown');
          destinationSubmissionAttemptedRef.current = true;
          setDestinationSubmissionAttempted(true);
          setError(new Error('Destination mint submission outcome is unknown. Check destination wallet activity before continuing; another mint will not be submitted.'));
          setExecutionStatus(runId, 'needs-attention');
          persistRecovery('needs-attention', caughtError instanceof Error ? caughtError.message : 'Destination submission outcome is unknown.', 'submission-unknown');
        } else {
          destinationSubmissionStateRef.current = 'not-submitted';
          setDestinationSubmissionState('not-submitted');
          setError(getError(caughtError, 'Destination mint could not be prepared.'));
          setExecutionStatus(runId, 'attestation-ready');
          persistRecovery('attestation-ready', caughtError instanceof Error ? caughtError.message : 'Destination mint could not be prepared.', 'not-submitted');
        }
      } else if (!destinationHashRef.current && !walletSubmissionStarted) {
        destinationSubmissionStateRef.current = 'not-submitted';
        setDestinationSubmissionState('not-submitted');
        setError(getError(caughtError, 'Destination mint could not be prepared.'));
        setExecutionStatus(runId, 'attestation-ready');
        persistRecovery('attestation-ready', caughtError instanceof Error ? caughtError.message : 'Destination mint could not be prepared.', 'not-submitted');
      } else {
        if (destinationHashRef.current) {
          destinationSubmissionStateRef.current = 'submitted';
          setDestinationSubmissionState('submitted');
        }
        setError(getError(caughtError, 'Destination mint failed.'));
        setExecutionStatus(runId, 'error');
        persistRecovery('error', caughtError instanceof Error ? caughtError.message : 'Destination mint failed.', destinationSubmissionStateRef.current);
      }
      throw getError(caughtError, 'Destination mint failed.');
    } finally {
      destinationRunLockRef.current = false;
      setIsSubmitting(false);
    }
  };

  const reset = () => {
    if (destinationRunLockRef.current || !executionGateRef.current.reset()) return;
    if (recoveryKey) setDismissedRecoveryKey(recoveryKey);
    executionRunIdRef.current += 1;
    sourceHashRef.current = undefined;
    executionWalletRef.current = undefined;
    cctpSourceConfirmedRef.current = false;
    recoveryTimingRef.current = undefined;
    destinationHashRef.current = undefined;
    destinationSubmissionAttemptedRef.current = false;
    destinationSubmissionStateRef.current = 'not-submitted';
    setSourceSubmissionAttempted(false);
    executionQuoteRef.current = undefined;
    setStatus('idle');
    setSourceHash(undefined);
    setDestinationHash(undefined);
    setDestinationVerified(false);
    setDestinationSubmissionAttempted(false);
    setDestinationSubmissionState('not-submitted');
    setSourceReceiptConfirmed(false);
    setBridgeStatus(undefined);
    setError(null);
    setRecoverySaveError(null);
  };

  return {
    execute,
    retryCctpSourceReceipt,
    retryCctpAttestation,
    complete,
    reset,
    status,
    sourceHash,
    destinationHash,
    destinationVerified,
    destinationSubmissionAttempted,
    destinationSubmissionState,
    sourceSubmissionAttempted,
    sourceReceiptConfirmed,
    executionWalletAddress: executionWalletRef.current,
    error,
    recoverySaveError,
    isSubmitting,
    quote: isBridgeExecutionStarted(status, sourceHash) ? executionQuoteRef.current : quote,
    bridgeStatus,
  };
}
