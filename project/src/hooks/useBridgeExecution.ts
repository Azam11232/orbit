import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';
import { decodeEventLog, encodeFunctionData, erc20Abi, formatUnits, type Address, type EIP1193Provider, type Hash, type Hex } from 'viem';
import type { BridgeQuote, BridgeStatus } from '../types/bridge';
import { cctpMessageTransmitterAbi } from '../services/bridge/cctp';
import { CircleForwardingError, executeCircleForwarding, getForwardingPollRetryDelay, getForwardingStatusOutcome, isAuthoritativeForwardingSuccess, isCircleForwardingSupported, isFastArcSepoliaForwarding, pollCircleForwardingStatus } from '../services/bridge/circleForwarding';
import { getOrbitNetwork } from '../data/networks';
import { markArcForwardingTiming, timeArcForwardingAwait, type ArcForwardingTiming } from '../services/bridge/arcForwardingTiming';

export type BridgeExecutionStatus = 'idle' | 'preflight' | 'approval-required' | 'approval-pending' | 'approval-confirmed' | 'source-pending' | 'source-confirmed' | 'attestation-pending' | 'attestation-ready' | 'destination-pending' | 'destination-confirmed' | 'verification-pending' | 'completed' | 'error' | 'cancelled';
const QUOTE_MAX_AGE_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 180_000;
const FORWARDING_POLL_TIMEOUT_MS = 180_000;
export const FORWARDING_RECONCILIATION_INTERVAL_MS = 1_000;

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

export function getRequiredBridgeChainId(input: { status: BridgeExecutionStatus; sourceChainId: number; destinationChainId: number; forwarding?: boolean }) {
  if (input.forwarding) return input.sourceChainId;
  return input.status === 'destination-pending' || input.status === 'destination-confirmed' || input.status === 'verification-pending' ? input.destinationChainId : input.sourceChainId;
}

export function shouldSkipInitialForwardingStatusPoll(initialStatusAvailable: boolean) {
  return initialStatusAvailable;
}

export function canApplyForwardingPending(completed: boolean) {
  return !completed;
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

export function shouldResetBridgeExecution(input: { sourceHash?: Hash; routeChanged: boolean; amountChanged: boolean; accountChanged: boolean; sourceNetworkChanged: boolean }) {
  return !input.sourceHash && (input.routeChanged || input.amountChanged || input.accountChanged || input.sourceNetworkChanged);
}

export function isBridgeExecutionStarted(status: BridgeExecutionStatus, sourceHash?: Hash) {
  return Boolean(sourceHash) || status === 'source-pending' || status === 'source-confirmed' || status === 'attestation-pending' || status === 'attestation-ready' || status === 'destination-pending' || status === 'destination-confirmed' || status === 'verification-pending' || status === 'completed';
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

export function useBridgeExecution(quote: BridgeQuote | undefined) {
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
  const [error, setError] = useState<Error | null>(null);
  const forwardingStatusSeededRef = useRef(false);
  const forwardingCompletedRef = useRef(false);
  const forwardingTimingRef = useRef<ArcForwardingTiming>();
  const activeQuoteRef = useRef<BridgeQuote>();
  const sourceSubmissionGuardRef = useRef(createBridgeExecutionOneShotGuard());
  const sourceSubmissionKeyRef = useRef<string | null>(null);
  const destinationCompletionGuardRef = useRef(createBridgeExecutionOneShotGuard());
  const destinationCompletionKeyRef = useRef<string | null>(null);
  const activeQuote = sourceHash ? activeQuoteRef.current ?? quote : quote;
  const reset = useCallback(() => {
    setStatus('idle');
    setSourceHash(undefined);
    setDestinationHash(undefined);
    setDestinationVerified(false);
    setError(null);
    forwardingStatusSeededRef.current = false;
    forwardingCompletedRef.current = false;
    activeQuoteRef.current = undefined;
    if (sourceSubmissionKeyRef.current) {
      sourceSubmissionGuardRef.current.release(sourceSubmissionKeyRef.current);
      sourceSubmissionKeyRef.current = null;
    }
    if (destinationCompletionKeyRef.current) {
      destinationCompletionGuardRef.current.release(destinationCompletionKeyRef.current);
      destinationCompletionKeyRef.current = null;
    }
    queryClient.removeQueries({ queryKey: ['bridge-status'] });
  }, [queryClient]);
  const beginReview = useCallback(() => {
    setError(null);
    setStatus((current) => current === 'idle' || current === 'error' ? 'preflight' : current);
  }, []);

  useEffect(() => {
    if (status !== 'destination-pending' || !sourceHash || !address || !connector || !activeQuote || !isCircleForwardingSupported(activeQuote.fromChain.id, activeQuote.toChain.id)) return;
    let cancelled = false;
    const startedAt = Date.now();
    const reconcile = async () => {
      if (shouldSkipInitialForwardingStatusPoll(forwardingStatusSeededRef.current)) {
        forwardingStatusSeededRef.current = false;
        await new Promise<void>((resolve) => window.setTimeout(resolve, FORWARDING_RECONCILIATION_INTERVAL_MS));
        if (cancelled || forwardingCompletedRef.current) return;
      }
      while (!cancelled && Date.now() - startedAt < FORWARDING_POLL_TIMEOUT_MS) {
        try {
          const provider = await connector.getProvider();
          const forwardingPollRetryDelay = getForwardingPollRetryDelay(activeQuote.fromChain.id, activeQuote.toChain.id);
          const forwarding = await pollCircleForwardingStatus({
            provider: provider as EIP1193Provider,
            sourceChainId: activeQuote.fromChain.id,
            sourceHash,
            recipient: address,
            timing: forwardingTimingRef.current,
            pollingConfig: isFastArcSepoliaForwarding(activeQuote.fromChain.id, activeQuote.toChain.id) ? { maxRetries: 1, retryDelay: forwardingPollRetryDelay } : undefined,
          });
          if (forwarding) markArcForwardingTiming(forwardingTimingRef.current, 'Circle status response received');
          if (forwarding?.forwardTxHash) markArcForwardingTiming(forwardingTimingRef.current, 'destination hash received');
          if (cancelled) return;
          const outcome = getForwardingStatusOutcome(forwarding?.forwardState, forwarding?.forwardTxHash);
          if (outcome === 'failed') {
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
            if (!destination || !verifyDestinationReceipt({
              receiptStatus: receipt.status,
              receiptTo: receipt.to,
              expectedMessageTransmitter: destination.messageTransmitterV2,
              expectedToken: destination.usdc,
              recipient: address,
              expectedAmount: activeQuote.toAmount ?? activeQuote.fromAmount,
              requireExactAmount: false,
              logs: receipt.logs,
            })) {
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
          if (import.meta.env.DEV) console.debug('[Orbit bridge] forwarding reconciliation poll failed', { sourceHash, error: caughtError instanceof Error ? caughtError.message : String(caughtError) });
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, FORWARDING_RECONCILIATION_INTERVAL_MS));
      }
      if (!cancelled && import.meta.env.DEV) console.debug('[Orbit bridge] forwarding reconciliation timed out', { sourceHash, timeoutMs: FORWARDING_POLL_TIMEOUT_MS });
    };
    void reconcile();
    return () => { cancelled = true; };
  }, [activeQuote, address, connector, queryClient, sourceHash, status]);
  const execute = async (timing?: ArcForwardingTiming) => {
    forwardingTimingRef.current = timing;
    markArcForwardingTiming(timing, 'execute() started');
    setError(null);
    if (quote) activeQuoteRef.current = quote;
    if (status !== 'idle' && status !== 'preflight' && status !== 'error' && status !== 'cancelled') {
      const nextError = new Error('A bridge transaction is already in progress');
      setStatus('error');
      setError(nextError);
      return;
    }
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
      const nextError = new Error('Bridge source transaction already in progress');
      setStatus('error');
      setError(nextError);
      return;
    }
    sourceSubmissionKeyRef.current = sourceSubmissionKey;
    forwardingStatusSeededRef.current = false;
    forwardingCompletedRef.current = false;
    setStatus('preflight');
    if (!quote || !address || !publicClient) { const nextError = new Error('Bridge quote or source RPC is unavailable'); setStatus('error'); setError(nextError); if (sourceSubmissionKeyRef.current) { sourceSubmissionGuardRef.current.release(sourceSubmissionKeyRef.current); sourceSubmissionKeyRef.current = null; } return; }
    if (chainId !== quote.fromChain.id) { const nextError = new Error(`Switch to ${quote.fromChain.name} before bridging`); setStatus('error'); setError(nextError); return; }
    if (Date.now() - quote.quotedAt > QUOTE_MAX_AGE_MS) { const nextError = new Error('Bridge quote expired. Refresh the quote'); setStatus('error'); setError(nextError); return; }
    const selectedRoute = quote.selectedRoute ?? (isCircleForwardingSupported(quote.fromChain.id, quote.toChain.id) ? 'forwarding' : 'cctp');
    const forwardingEnabled = selectedRoute === 'forwarding';
    if (!forwardingEnabled && (!quote.transactionTarget || !quote.transactionData || quote.transactionData === '0x')) { const nextError = new Error('Bridge transaction data is incomplete'); setStatus('error'); setError(nextError); return; }
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
    if (currentBalance !== undefined && currentBalance < getRequiredSourceDebit(quote)) { const nextError = new Error('Insufficient source-chain balance for the quoted transfer and fees'); setStatus('error'); setError(nextError); if (sourceSubmissionKeyRef.current) { sourceSubmissionGuardRef.current.release(sourceSubmissionKeyRef.current); sourceSubmissionKeyRef.current = null; } return; }
    const preflightTarget = quote.transactionTarget;
    const preflightData = quote.transactionData;
    if (!forwardingEnabled) {
      if (!preflightTarget || !preflightData) throw new Error('Bridge transaction data is incomplete');
      const code = await publicClient.getBytecode({ address: preflightTarget });
      if (!code || code === '0x') { const nextError = new Error('Bridge transaction target is not a contract on the source chain'); setStatus('error'); setError(nextError); if (sourceSubmissionKeyRef.current) { sourceSubmissionGuardRef.current.release(sourceSubmissionKeyRef.current); sourceSubmissionKeyRef.current = null; } return; }
      if (quote.fromToken.isNative && quote.transactionValue !== quote.fromAmount) { const nextError = new Error('Bridge value does not match the quoted amount'); setStatus('error'); setError(nextError); if (sourceSubmissionKeyRef.current) { sourceSubmissionGuardRef.current.release(sourceSubmissionKeyRef.current); sourceSubmissionKeyRef.current = null; } return; }
    }
      if (!forwardingEnabled) {
        if (!destinationClient) throw new Error('Destination RPC is unavailable for gas preflight');
        const destination = getOrbitNetwork(quote.toChain.id);
        if (!destination) throw new Error('Destination network is not configured for CCTP');
        if (!preflightTarget || !preflightData) throw new Error('Bridge transaction data is incomplete');
        const destinationNativeBalance = await destinationClient.getBalance({ address });
        if (destinationNativeBalance === 0n) throw new Error(`Destination gas required: your wallet needs ${destination.nativeCurrency.symbol} on ${quote.toChain.name} to complete the destination mint`);
        const gas = await publicClient.estimateGas({ account: address, to: preflightTarget, data: preflightData, value: quote.transactionValue });
        const gasPrice = await publicClient.getGasPrice();
        const nativeBalance = await publicClient.getBalance({ address });
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
            } else if (stepName === 'burn' && step.state === 'success' && step.txHash) {
              markArcForwardingTiming(timing, 'source tx hash available');
              markArcForwardingTiming(timing, 'source receipt confirmed');
              setSourceHash(step.txHash as Hash);
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
      const hash = await sendTransactionAsync({ to: transactionTarget, data: transactionData, value: quote.transactionValue, chainId: quote.fromChain.id });
      setSourceHash(hash); setStatus('source-pending');
      const sourceReceipt = await Promise.race([publicClient.waitForTransactionReceipt({ hash }), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Source transaction confirmation timed out')), RECEIPT_TIMEOUT_MS))]);
      if (sourceReceipt.status !== 'success' || sourceReceipt.to?.toLowerCase() !== transactionTarget.toLowerCase()) throw new Error('Bridge source transaction did not confirm against the quoted source contract');
      setStatus('source-confirmed');
      await queryClient.invalidateQueries();
      return hash;
    } catch (caughtError) {
      if (caughtError instanceof CircleForwardingError) {
        if (caughtError.sourceHash) setSourceHash(caughtError.sourceHash);
        if (caughtError.destinationHash) setDestinationHash(caughtError.destinationHash);
      }
      if (sourceSubmissionKeyRef.current) {
        sourceSubmissionGuardRef.current.release(sourceSubmissionKeyRef.current);
        sourceSubmissionKeyRef.current = null;
      }
      setStatus('error'); setError(caughtError instanceof Error ? caughtError : new Error('Bridge transaction failed')); return undefined;
    }
  };
  const markAttestationPending = useCallback(() => {
    setStatus((current) => current === 'source-confirmed' ? 'attestation-pending' : current);
  }, []);
  const markAttestationReady = useCallback(() => {
    setStatus((current) => current === 'source-confirmed' || current === 'attestation-pending' ? 'attestation-ready' : current);
  }, []);
  const complete = async (message: Hex | undefined, attestation: Hex | undefined) => {
    setError(null);
    if ((status !== 'source-confirmed' && status !== 'attestation-pending' && status !== 'attestation-ready') || !address || !quote || !message || !attestation || !destinationClient) {
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
    try {
      setStatus('attestation-ready');
      await switchChainAsync({ chainId: quote.toChain.id });
      const data = encodeFunctionData({ abi: cctpMessageTransmitterAbi, functionName: 'receiveMessage', args: [message, attestation] });
      const gas = await destinationClient.estimateGas({ account: address, to: destination.messageTransmitterV2, data, value: 0n });
      const gasPrice = await destinationClient.getGasPrice();
      const nativeBalance = await destinationClient.getBalance({ address });
      const destinationGasRequired = gas * gasPrice;
      if (nativeBalance < destinationGasRequired) throw new Error(`Insufficient ${destination.nativeCurrency.symbol} for destination mint: requires approximately ${formatUnits(destinationGasRequired, destination.nativeCurrency.decimals)} ${destination.nativeCurrency.symbol}, wallet has ${formatUnits(nativeBalance, destination.nativeCurrency.decimals)} ${destination.nativeCurrency.symbol}`);

      setStatus('destination-pending');
      const hash = await sendTransactionAsync({ to: destination.messageTransmitterV2, data, value: 0n, chainId: quote.toChain.id });
      setDestinationHash(hash);
      const destinationReceipt = await Promise.race([destinationClient.waitForTransactionReceipt({ hash }), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Destination transaction confirmation timed out')), RECEIPT_TIMEOUT_MS))]);
      if (destinationReceipt.status !== 'success') throw new Error('Bridge destination transaction reverted');

      setStatus('destination-confirmed');
      setStatus('verification-pending');
      const receiptVerified = verifyDestinationReceipt({
        receiptStatus: destinationReceipt.status,
        receiptTo: destinationReceipt.to,
        expectedMessageTransmitter: destination.messageTransmitterV2,
        expectedToken: destination.usdc,
        recipient: address,
        expectedAmount: quote.toAmount ?? quote.fromAmount,
        logs: destinationReceipt.logs,
      });

      if (!receiptVerified) {
        const nextError = new Error('Destination USDC verification failed: the confirmed receipt did not contain the expected canonical USDC transfer');
        setStatus('error');
        setError(nextError);
        return undefined;
      }
      setDestinationVerified(true);

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
      if (destinationCompletionKeyRef.current === destinationCompletionKey) {
        destinationCompletionGuardRef.current.release(destinationCompletionKey);
        destinationCompletionKeyRef.current = null;
      }
      setStatus('error');
      setError(caughtError instanceof Error ? caughtError : new Error('Destination mint failed'));
      return undefined;
    }
  };
  return { beginReview, execute, complete, reset, markAttestationPending, markAttestationReady, status, sourceHash, destinationHash, destinationVerified, error, quote: activeQuote };
}
