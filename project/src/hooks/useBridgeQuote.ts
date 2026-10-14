import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { formatUnits, type Address } from 'viem';
import { createCctpProvider } from '../services/bridge/cctp';
import { createCircleEstimatedBridgeQuote, estimateCircleForwarding, estimateStandardCircleCctp, getCircleEstimateFeeTotal, isCircleForwardingSupported, isStandardCctpSupported, selectCircleBridgeRoute } from '../services/bridge/circleForwarding';
import { ARC_PRIMARY_NETWORK, ETHEREUM_SEPOLIA } from '../data/networks';
import { associateBridgeQuoteTiming, beginArcForwardingTiming, getBridgeErrorCategory, markArcForwardingTiming, timeArcForwardingAwait } from '../services/bridge/arcForwardingTiming';
import type { BridgeChain, BridgeQuote, BridgeToken } from '../types/bridge';

const provider = createCctpProvider();
const BRIDGE_QUOTE_MAX_AGE_MS = 30_000;

export type BridgeQuoteFreshnessState = 'unavailable' | 'loading' | 'refreshing' | 'refresh-failed' | 'stale' | 'fresh';

export function getBridgeQuoteFreshnessState(input: {
  hasQuote: boolean;
  quoteCurrent: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
}): BridgeQuoteFreshnessState {
  if (input.isFetching) return input.hasQuote ? 'refreshing' : 'loading';
  if (input.isError) return input.hasQuote ? 'refresh-failed' : 'unavailable';
  if (input.hasQuote && !input.quoteCurrent) return 'stale';
  if (input.isLoading) return 'loading';
  if (!input.hasQuote) return 'unavailable';
  return 'fresh';
}

export function isBridgeReviewable(input: { isConnected: boolean; wrongNetwork: boolean; sameNetwork: boolean; hasSourceToken: boolean; hasDestinationToken: boolean; hasQuote: boolean; hasAmount: boolean; hasAmountError: boolean; quoteFresh: boolean; feeValid?: boolean }) {
  return input.isConnected && !input.wrongNetwork && !input.sameNetwork && input.hasSourceToken && input.hasDestinationToken && input.hasQuote && input.hasAmount && !input.hasAmountError && input.quoteFresh && input.feeValid !== false;
}

export function shouldFetchBridgeQuote(input: { executionStarted: boolean; amount: bigint | null; debouncedAmount: bigint | null; hasSourceToken: boolean; hasDestinationToken: boolean; hasAddress: boolean; sameNetwork: boolean }) {
  return !input.executionStarted &&
    input.amount !== null &&
    input.amount > 0n &&
    input.debouncedAmount === input.amount &&
    input.hasSourceToken &&
    input.hasDestinationToken &&
    input.hasAddress &&
    !input.sameNetwork;
}

export function isBridgeQuoteCurrent(input: {
  quote?: BridgeQuote;
  sourceChainId: number;
  destinationChainId: number;
  sourceToken?: BridgeToken;
  destinationToken?: BridgeToken;
  recipientAddress?: Address;
  amount: bigint | null;
  selectedRoute?: BridgeQuote['selectedRoute'];
  now?: number;
  maxAgeMs?: number;
}) {
  const { quote } = input;
  if (!quote || !input.sourceToken || !input.destinationToken || input.amount === null || input.amount <= 0n) return false;
  const quoteAge = (input.now ?? Date.now()) - quote.quotedAt;
  return quoteAge >= 0 &&
    quoteAge <= (input.maxAgeMs ?? BRIDGE_QUOTE_MAX_AGE_MS) &&
    quote.fromChain.id === input.sourceChainId &&
    quote.toChain.id === input.destinationChainId &&
    quote.fromToken.chainId === input.sourceChainId &&
    quote.fromToken.address.toLowerCase() === input.sourceToken.address.toLowerCase() &&
    quote.toToken.chainId === input.destinationChainId &&
    quote.toToken.address.toLowerCase() === input.destinationToken.address.toLowerCase() &&
    (input.recipientAddress === undefined || quote.recipientAddress?.toLowerCase() === input.recipientAddress.toLowerCase()) &&
    quote.fromAmount === input.amount &&
    (input.selectedRoute === undefined || quote.selectedRoute === input.selectedRoute);
}

type BridgeQuoteSnapshot = Pick<BridgeQuote, 'id' | 'quotedAt' | 'selectedRoute' | 'fromAmount' | 'toAmount' | 'toAmountMin' | 'feeAmount' | 'forwardingFeeAmount' | 'protocolFeeAmount' | 'fromChain' | 'toChain' | 'fromToken' | 'toToken' | 'recipientAddress'>;

export function isSameBridgeQuoteSnapshot(current: BridgeQuoteSnapshot | undefined, reviewed: BridgeQuoteSnapshot | undefined) {
  return Boolean(
    current &&
    reviewed &&
    current.id === reviewed.id &&
    current.quotedAt === reviewed.quotedAt &&
    current.selectedRoute === reviewed.selectedRoute &&
    current.fromAmount === reviewed.fromAmount &&
    current.toAmount === reviewed.toAmount &&
    current.toAmountMin === reviewed.toAmountMin &&
    current.feeAmount === reviewed.feeAmount &&
    current.forwardingFeeAmount === reviewed.forwardingFeeAmount &&
    current.protocolFeeAmount === reviewed.protocolFeeAmount &&
    current.fromChain.id === reviewed.fromChain.id &&
    current.toChain.id === reviewed.toChain.id &&
    current.fromToken.address.toLowerCase() === reviewed.fromToken.address.toLowerCase() &&
    current.toToken.address.toLowerCase() === reviewed.toToken.address.toLowerCase() &&
    current.recipientAddress?.toLowerCase() === reviewed.recipientAddress?.toLowerCase(),
  );
}

export function shouldAutoRefreshBridgeQuote(input: {
  quoteExpired: boolean;
  queryEnabled: boolean;
  executionStarted: boolean;
  isFetching: boolean;
}) {
  return input.quoteExpired && input.queryEnabled && !input.executionStarted && !input.isFetching;
}

export function isBridgeExecutable(input: { isBridgeReviewable: boolean; allowance: bigint; amount: bigint | null; simulationSucceeded: boolean; isSimulating: boolean; feeValid?: boolean; approvalManagedByExecutor?: boolean }) {
  const allowanceSatisfied = input.allowance >= (input.amount ?? 0n);
  return input.isBridgeReviewable && input.feeValid !== false && input.amount !== null && allowanceSatisfied && input.simulationSucceeded && !input.isSimulating;
}

export function canSimulateBridgeBurn(allowance: bigint, amount: bigint | null) {
  return amount !== null && amount > 0n && allowance >= amount;
}

export function isManualBridgeSimulationRequired(routeOrForwardingEnabled: boolean | BridgeQuote['selectedRoute'] | null | undefined) {
  if (typeof routeOrForwardingEnabled === 'boolean') return !routeOrForwardingEnabled;
  return routeOrForwardingEnabled === 'cctp';
}

export function isForwardingFeeViable(amount: bigint, fee: bigint) {
  return fee < amount;
}

export function calculateDestinationReceived(amount: bigint, fee: bigint) {
  return amount > fee ? amount - fee : 0n;
}

export function getRouteMinimumTransferAmount(feePayment: 'source' | 'destination' | undefined, totalFee: bigint) {
  return feePayment === 'destination' ? totalFee + 1n : null;
}

export function shouldFallbackFromForwardingToCctp(input: { feePayment?: 'source' | 'destination'; amount: bigint | null; totalFee?: bigint | null; feeError?: string | null }) {
  if (input.feePayment !== 'destination' || input.amount === null || input.amount <= 0n) return false;
  if (typeof input.feeError === 'string' && input.feeError.includes('Amount too small for the current forwarding fee')) return true;
  return Boolean(input.totalFee !== null && input.totalFee !== undefined && input.totalFee >= input.amount);
}

export function getRouteFeeError(input: { feePayment: 'source' | 'destination' | undefined; amount: bigint | null; totalFee: bigint; forwardingFee: bigint; protocolFee: bigint }) {
  if (input.feePayment !== 'destination' || input.amount === null || input.amount <= 0n) {
    return undefined;
  }
  if (input.totalFee >= input.amount) {
    return `Amount too small for the current forwarding fee. Estimated forwarding fee: ${formatUnits(input.forwardingFee, 6)} USDC${input.protocolFee > 0n ? `; protocol fee: ${formatUnits(input.protocolFee, 6)} USDC` : ''}. Minimum required: ${formatUnits(input.totalFee + 1n, 6)} USDC.`;
  }
  return undefined;
}

export interface BridgeExecutionReadiness {
  activeExecution?: boolean;
  quoteReady: boolean;
  feeValid: boolean;
  feeError?: string;
  approvalRequired: boolean;
  allowanceSufficient: boolean;
  approvalReady: boolean;
  simulationReady: boolean;
  simulationLoading: boolean;
  simulationError?: string;
  destinationGasReady: boolean;
  executionStatusReady: boolean;
}

export function getBridgeExecutionBlocker(input: BridgeExecutionReadiness) {
  if (input.activeExecution) return null;
  if (!input.quoteReady) return 'Waiting for a fresh bridge quote.';
  if (!input.feeValid) return input.feeError ?? 'Amount too small for the current forwarding fee.';
  if (input.approvalRequired || !input.allowanceSufficient) return 'Approve exact amount before simulating the bridge burn.';
  if (input.simulationLoading) return 'Simulating the bridge burn...';
  if (input.simulationError) return `CCTP burn simulation failed: ${input.simulationError}`;
  if (!input.simulationReady) return 'Waiting for successful CCTP burn simulation.';
  if (!input.destinationGasReady) return 'Destination execution prerequisites are not ready.';
  if (!input.executionStatusReady) return 'Bridge execution is not ready to start.';
  return null;
}

export function isDestinationGasReady(input: { applicable: boolean; loading: boolean; balance: bigint | null; error?: boolean }) {
  return !input.applicable || (!input.loading && !input.error && input.balance !== null && input.balance > 0n);
}

export function useBridgeQuote(fromChain: BridgeChain, toChain: BridgeChain, fromToken: BridgeToken | undefined, toToken: BridgeToken | undefined, amount: bigint | null, address?: Address, slippage = 0.005, allowanceVerified = false, walletConnector?: { getProvider: () => Promise<unknown>; id?: string }, executionStarted = false, preferredRoute?: 'auto' | 'forwarding' | 'cctp') {
  const [debouncedAmount, setDebouncedAmount] = useState<bigint | null>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedAmount(amount), 350);
    return () => window.clearTimeout(timeout);
  }, [amount]);
  const quoteQueryEnabled = shouldFetchBridgeQuote({
    executionStarted,
    amount,
    debouncedAmount,
    hasSourceToken: Boolean(fromToken),
    hasDestinationToken: Boolean(toToken),
    hasAddress: Boolean(address),
    sameNetwork: fromChain.id === toChain.id,
  });
  const query = useQuery<BridgeQuote>({
    queryKey: ['bridge-quote', fromChain.id, toChain.id, fromToken?.address, toToken?.address, debouncedAmount?.toString(), address, slippage, walletConnector?.id ?? null, preferredRoute],
    queryFn: async () => {
      const timing = beginArcForwardingTiming('quote requested');
      const request = { fromChain, toChain, fromToken: fromToken as BridgeToken, toToken: toToken as BridgeToken, fromAmount: debouncedAmount as bigint, fromAddress: address as Address, toAddress: address as Address, slippage };
      const quote = {
        ...await timeArcForwardingAwait(timing, 'Bridge quote generation', () => provider.getQuote(request)),
        recipientAddress: address as Address,
      };
      const forwardingSupported = isCircleForwardingSupported(fromChain.id, toChain.id);
      const standardSupported = isStandardCctpSupported(fromChain.id, toChain.id);
      if (!forwardingSupported && !standardSupported) throw new Error('Circle has no supported route for this network pair');
      const selectableArcSepoliaRoute = fromChain.id === ARC_PRIMARY_NETWORK.id && toChain.id === ETHEREUM_SEPOLIA.id && preferredRoute !== undefined;
      if (!walletConnector) throw new Error('Connect a wallet to retrieve a live Circle route quote');
      const diagnosticContext = {
        route: 'forwarding',
        sourceChain: fromChain.id,
        destinationChain: toChain.id,
        amount: (debouncedAmount as bigint).toString(),
        feePayment: 'destination' as const,
        connectorExists: Boolean(walletConnector),
      };
      const logDiagnosticError = (stage: string, error: unknown) => {
        if (!import.meta.env.DEV) return;
        console.error('[Orbit bridge] forwarding diagnostic failure', { ...diagnosticContext, stage, errorCategory: getBridgeErrorCategory(error) });
      };
      let walletProvider: import('viem').EIP1193Provider;
      try {
        walletProvider = await timeArcForwardingAwait(timing, 'wallet provider acquisition for quote', () => walletConnector.getProvider()) as import('viem').EIP1193Provider;
      } catch (error) {
        logDiagnosticError('walletConnector.getProvider', error);
        throw error;
      }
      if (selectableArcSepoliaRoute) {
        try {
          const standardSupported = isStandardCctpSupported(fromChain.id, toChain.id);
          const forwardingSupported = isCircleForwardingSupported(fromChain.id, toChain.id);
          const [standardResult, forwardingResult] = await Promise.allSettled([
            standardSupported
              ? estimateStandardCircleCctp({
                provider: walletProvider,
                sourceChainId: fromChain.id,
                destinationChainId: toChain.id,
                recipient: address as Address,
                amount: debouncedAmount as bigint,
                timing,
              })
              : Promise.resolve(undefined),
            forwardingSupported
              ? estimateCircleForwarding({ provider: walletProvider, sourceChainId: fromChain.id, destinationChainId: toChain.id, recipient: address as Address, amount: debouncedAmount as bigint, timing }, (stage, error) => {
                logDiagnosticError(stage, error);
              })
              : Promise.resolve(undefined),
          ]);
          if (standardResult.status === 'rejected') logDiagnosticError('estimateStandardCircleCctp', standardResult.reason);
          if (forwardingResult.status === 'rejected') logDiagnosticError('estimateCircleForwarding', forwardingResult.reason);
          const standardEstimate = standardResult.status === 'fulfilled' ? standardResult.value : undefined;
          const forwardingEstimate = forwardingResult.status === 'fulfilled' ? forwardingResult.value : undefined;
          if (!standardEstimate && !forwardingEstimate) {
            throw new Error('Circle did not return a fresh estimate for either supported route. Retry when Circle and the selected networks are available.');
          }
          const standardFee = standardEstimate ? getCircleEstimateFeeTotal(standardEstimate) : undefined;
          const recommendedRoute = selectCircleBridgeRoute({
            forwardingSupported: Boolean(forwardingEstimate),
            standardCctpSupported: Boolean(standardEstimate),
            forwardingFeeAmount: forwardingEstimate?.totalFee,
            standardCctpFeeAmount: standardFee,
          });
          const selectedRoute = preferredRoute === 'auto' || preferredRoute === undefined ? recommendedRoute : preferredRoute;
          const routeComparison = {
            forwardingFeeAmount: forwardingEstimate?.totalFee ?? null,
            standardCctpFeeAmount: standardFee ?? null,
            recommendedRoute,
          };
          if (selectedRoute === 'cctp') {
            if (!standardEstimate) throw new Error('Standard CCTP is not supported for the selected route');
            const standardQuote = createCircleEstimatedBridgeQuote(quote, standardEstimate, 'cctp', address as Address);
            const feeError = getRouteFeeError({
              feePayment: 'destination',
              amount: debouncedAmount as bigint,
              totalFee: standardQuote.feeAmount ?? 0n,
              forwardingFee: standardQuote.forwardingFeeAmount ?? 0n,
              protocolFee: standardQuote.protocolFeeAmount ?? 0n,
            });
            return associateBridgeQuoteTiming({
              ...standardQuote,
              minimumTransferAmount: getRouteMinimumTransferAmount('destination', standardQuote.feeAmount ?? 0n),
              feeError,
              routeComparison,
            }, timing);
          }
          if (!forwardingEstimate) throw new Error('Circle forwarding is not supported for the selected route');
          const estimate = forwardingEstimate;
          const forwardingQuote = createCircleEstimatedBridgeQuote(quote, estimate.sdkEstimate, 'forwarding', address as Address);
          const feeError = getRouteFeeError({
            feePayment: estimate.feePayment,
            amount: debouncedAmount as bigint,
            totalFee: estimate.totalFee,
            forwardingFee: estimate.forwardingFee,
            protocolFee: estimate.protocolFee,
          });
          return associateBridgeQuoteTiming({
            ...forwardingQuote,
            feeAmount: estimate.totalFee,
            forwardingFeeAmount: estimate.forwardingFee,
            protocolFeeAmount: estimate.protocolFee,
            totalSourceDebit: estimate.totalSourceDebit,
            feePayment: estimate.feePayment,
            minimumTransferAmount: getRouteMinimumTransferAmount(estimate.feePayment, estimate.totalFee),
            feeError,
            routeComparison,
            transactionTarget: null,
            transactionData: null,
            raw: { ...((forwardingQuote.raw as object) ?? {}), forwardingFees: estimate.fees, feePayment: estimate.feePayment, transferSpeed: estimate.transferSpeed, quote: estimate.quote },
          }, timing);
        } catch (error) {
          logDiagnosticError('compareCircleRoutes', error);
          throw error;
        }
      }
      if (!forwardingSupported) {
        try {
          const estimate = await estimateStandardCircleCctp({
            provider: walletProvider,
            sourceChainId: fromChain.id,
            destinationChainId: toChain.id,
            recipient: address as Address,
            amount: debouncedAmount as bigint,
            timing,
          });
          const standardQuote = createCircleEstimatedBridgeQuote(quote, estimate, 'cctp', address as Address);
          const feeError = getRouteFeeError({
            feePayment: 'destination',
            amount: debouncedAmount as bigint,
            totalFee: standardQuote.feeAmount ?? 0n,
            forwardingFee: standardQuote.forwardingFeeAmount ?? 0n,
            protocolFee: standardQuote.protocolFeeAmount ?? 0n,
          });
          return associateBridgeQuoteTiming({
            ...standardQuote,
            minimumTransferAmount: getRouteMinimumTransferAmount('destination', standardQuote.feeAmount ?? 0n),
            feeError,
          }, timing);
        } catch (error) {
          logDiagnosticError('estimateStandardCircleCctp', error);
          throw error;
        }
      }
      let estimate;
      let diagnosticFailureReported = false;
      try {
        estimate = await estimateCircleForwarding({ provider: walletProvider, sourceChainId: fromChain.id, destinationChainId: toChain.id, recipient: address as Address, amount: debouncedAmount as bigint, timing }, (stage, error) => {
          diagnosticFailureReported = true;
          logDiagnosticError(stage, error);
        });
      } catch (error) {
        if (!diagnosticFailureReported) logDiagnosticError('estimateCircleForwarding', error);
        throw error;
      }
      if (import.meta.env.DEV) console.debug('[Orbit bridge] forwarding diagnostic success', {
        ...diagnosticContext,
        selectedRoute: 'forwarding',
        feePayment: estimate.feePayment,
        totalFee: estimate.totalFee.toString(),
        destinationAmount: estimate.destinationAmount.toString(),
        totalSourceDebit: estimate.totalSourceDebit.toString(),
      });
      const minimumTransferAmount = getRouteMinimumTransferAmount(estimate.feePayment, estimate.totalFee);
      const feeError = getRouteFeeError({
        feePayment: estimate.feePayment,
        amount: debouncedAmount as bigint,
        totalFee: estimate.totalFee,
        forwardingFee: estimate.forwardingFee,
        protocolFee: estimate.protocolFee,
      });
      return associateBridgeQuoteTiming({
        ...quote,
        feeAmount: estimate.totalFee,
        forwardingFeeAmount: estimate.forwardingFee,
        protocolFeeAmount: estimate.protocolFee,
        totalSourceDebit: estimate.totalSourceDebit,
        feePayment: estimate.feePayment,
        transferSpeed: selectableArcSepoliaRoute
          ? 'Circle forwarding; Arc Standard CCTP attestation'
          : estimate.transferSpeed,
        gasEstimates: estimate.gasEstimates,
        gasCosts: estimate.gasEstimates.map((gas) => `${gas.step}: ${formatUnits(gas.amount, gas.decimals)} ${gas.tokenSymbol}`),
        minimumTransferAmount,
        toAmount: estimate.destinationAmount,
        toAmountMin: estimate.destinationAmount,
        feeError,
        selectedRoute: 'forwarding' as const,
        transactionTarget: null,
        transactionData: null,
        raw: { ...((quote.raw as object) ?? {}), forwardingFees: estimate.fees, feePayment: estimate.feePayment, transferSpeed: estimate.transferSpeed, quote: estimate.quote },
      }, timing);
    },
    enabled: quoteQueryEnabled,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now());
  const isFetchingRef = useRef(query.isFetching);
  isFetchingRef.current = query.isFetching;
  useEffect(() => {
    if (!query.data) return;
    setFreshnessNow(Date.now());
    const expiresAt = query.data.quotedAt + BRIDGE_QUOTE_MAX_AGE_MS;
    const timeout = window.setTimeout(
      () => {
        const now = Date.now();
        setFreshnessNow(now);
        if (shouldAutoRefreshBridgeQuote({
          quoteExpired: now > expiresAt,
          queryEnabled: quoteQueryEnabled,
          executionStarted,
          isFetching: isFetchingRef.current,
        })) void query.refetch();
      },
      Math.max(0, expiresAt - Date.now() + 1),
    );
    return () => window.clearTimeout(timeout);
  }, [executionStarted, query.data?.quotedAt, query.refetch, quoteQueryEnabled]);
  const sourceClient = usePublicClient({ chainId: fromChain.id });
  const forwardingEnabled = isCircleForwardingSupported(fromChain.id, toChain.id);
  const manualSimulationRequired = isManualBridgeSimulationRequired(query.data?.selectedRoute);
  if (import.meta.env.DEV) {
    console.debug('[BRIDGE DEBUG] manual simulation state', {
      fromChain: fromChain.id,
      toChain: toChain.id,
      forwardingEnabled,
      manualSimulationRequired,
      hasQuote: Boolean(query.data),
      hasTarget: Boolean(query.data?.transactionTarget),
      hasData: Boolean(query.data?.transactionData),
      allowanceVerified,
      feeError: query.data?.feeError,
      transactionTarget: query.data?.transactionTarget,
      requiredAmount: query.data?.totalSourceDebit?.toString() ?? query.data?.fromAmount?.toString() ?? null,
      allowance: undefined,
    });
  }
  const simulation = useQuery({
    queryKey: ['bridge-simulation', query.data?.id, query.data?.transactionData, query.data?.transactionValue?.toString(), query.data?.feeAmount?.toString(), query.data?.feePayment, query.data?.transferSpeed, address],
    queryFn: async () => {
      const logContext = {
        fromChain: fromChain.id,
        toChain: toChain.id,
        forwardingEnabled,
        manualSimulationRequired,
        quoteId: query.data?.id,
        target: query.data?.transactionTarget,
        requiredAmount: query.data?.totalSourceDebit?.toString() ?? query.data?.fromAmount?.toString() ?? null,
      };
      if (import.meta.env.DEV) console.debug('[BRIDGE DEBUG] simulation entering', logContext);
      if (!manualSimulationRequired) {
        if (import.meta.env.DEV) console.debug('[BRIDGE DEBUG] simulation skipped', logContext);
        return false;
      }
      if (!query.data?.transactionTarget || !query.data.transactionData || !sourceClient || !address) {
        if (import.meta.env.DEV) console.debug('[BRIDGE DEBUG] simulation unavailable', logContext);
        throw new Error('Bridge simulation is unavailable');
      }
      if (import.meta.env.DEV) console.debug('[BRIDGE DEBUG] simulate call', { ...logContext, to: query.data.transactionTarget, dataSelector: query.data.transactionData.slice(0, 10), value: query.data.transactionValue?.toString() ?? '0' });
      await sourceClient.call({ account: address, to: query.data.transactionTarget, data: query.data.transactionData, value: query.data.transactionValue });
      return true;
    },
    enabled: Boolean(query.data && sourceClient && address && allowanceVerified && !query.data.feeError && manualSimulationRequired),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return { quote: query.data, isLoading: query.isLoading || debouncedAmount !== amount, isFetching: query.isFetching, isError: query.isError, error: query.error, freshnessNow, simulationError: simulation.error, isSimulating: simulation.isLoading, simulationSucceeded: allowanceVerified && simulation.data === true, refetch: query.refetch, provider: 'Circle CCTP V2' };
}
