import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { formatUnits, type Address } from 'viem';
import { createCctpProvider } from '../services/bridge/cctp';
import { estimateCircleForwarding, isCircleForwardingSupported } from '../services/bridge/circleForwarding';
import type { BridgeChain, BridgeQuote, BridgeToken } from '../types/bridge';

const provider = createCctpProvider();

export function isBridgeReviewable(input: { isConnected: boolean; wrongNetwork: boolean; sameNetwork: boolean; hasSourceToken: boolean; hasDestinationToken: boolean; hasQuote: boolean; hasAmount: boolean; hasAmountError: boolean; quoteFresh: boolean; feeValid?: boolean }) {
  return input.isConnected && !input.wrongNetwork && !input.sameNetwork && input.hasSourceToken && input.hasDestinationToken && input.hasQuote && input.hasAmount && !input.hasAmountError && input.quoteFresh;
}

export function isBridgeExecutable(input: { isBridgeReviewable: boolean; allowance: bigint; amount: bigint | null; simulationSucceeded: boolean; isSimulating: boolean; feeValid?: boolean; approvalManagedByExecutor?: boolean }) {
  const allowanceSatisfied = input.allowance >= (input.amount ?? 0n);
  return input.isBridgeReviewable && input.feeValid !== false && input.amount !== null && allowanceSatisfied && input.simulationSucceeded && !input.isSimulating;
}

export function canSimulateBridgeBurn(allowance: bigint, amount: bigint | null) {
  return amount !== null && amount > 0n && allowance >= amount;
}

export function isManualBridgeSimulationRequired(routeOrForwardingEnabled: boolean | 'forwarding' | 'cctp' | null | undefined) {
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

export function useBridgeQuote(fromChain: BridgeChain, toChain: BridgeChain, fromToken: BridgeToken | undefined, toToken: BridgeToken | undefined, amount: bigint | null, address?: Address, slippage = 0.005, allowanceVerified = false, walletConnector?: { getProvider: () => Promise<unknown> }, executionStarted = false) {
  const [debouncedAmount, setDebouncedAmount] = useState<bigint | null>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedAmount(amount), 350);
    return () => window.clearTimeout(timeout);
  }, [amount]);
  const query = useQuery<BridgeQuote>({
    queryKey: ['bridge-quote', fromChain.id, toChain.id, fromToken?.address, toToken?.address, debouncedAmount?.toString(), address, slippage, Boolean(walletConnector)],
    queryFn: async () => {
      const request = { fromChain, toChain, fromToken: fromToken as BridgeToken, toToken: toToken as BridgeToken, fromAmount: debouncedAmount as bigint, fromAddress: address as Address, toAddress: address as Address, slippage };
      const quote = await provider.getQuote(request);
      if (!isCircleForwardingSupported(fromChain.id, toChain.id)) return quote;
      if (!walletConnector) {
        return {
          ...quote,
          selectedRoute: 'cctp' as const,
        };
      }
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
        const details = error instanceof Error ? { errorName: error.name, errorMessage: error.message } : { errorName: typeof error, errorMessage: String(error) };
        console.error('[Orbit bridge] forwarding diagnostic failure', { ...diagnosticContext, stage, ...details });
      };
      let walletProvider: import('viem').EIP1193Provider;
      try {
        if (import.meta.env.DEV) console.debug('[Orbit bridge] forwarding diagnostic stage', { ...diagnosticContext, stage: 'walletConnector.getProvider' });
        walletProvider = await walletConnector.getProvider() as import('viem').EIP1193Provider;
      } catch (error) {
        logDiagnosticError('walletConnector.getProvider', error);
        return {
          ...quote,
          selectedRoute: 'cctp' as const,
        };
      }
      let estimate;
      let diagnosticFailureReported = false;
      try {
        estimate = await estimateCircleForwarding({ provider: walletProvider, sourceChainId: fromChain.id, destinationChainId: toChain.id, recipient: address as Address, amount: debouncedAmount as bigint }, (stage, error) => {
          diagnosticFailureReported = true;
          logDiagnosticError(stage, error);
        });
      } catch (error) {
        if (!diagnosticFailureReported) logDiagnosticError('estimateCircleForwarding', error);
        return {
          ...quote,
          selectedRoute: 'cctp' as const,
        };
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
      const fallbackToCctp = shouldFallbackFromForwardingToCctp({ feePayment: estimate.feePayment, amount: debouncedAmount as bigint, totalFee: estimate.totalFee, feeError });
      if (fallbackToCctp) {
        return {
          ...quote,
          selectedRoute: 'cctp' as const,
        };
      }
      return {
        ...quote,
        feeAmount: estimate.totalFee,
        forwardingFeeAmount: estimate.forwardingFee,
        protocolFeeAmount: estimate.protocolFee,
        totalSourceDebit: estimate.totalSourceDebit,
        feePayment: estimate.feePayment,
        transferSpeed: estimate.transferSpeed,
        minimumTransferAmount,
        toAmount: estimate.destinationAmount,
        toAmountMin: estimate.destinationAmount,
        feeError,
        selectedRoute: 'forwarding' as const,
        transactionTarget: null,
        transactionData: null,
        raw: { ...((quote.raw as object) ?? {}), forwardingFees: estimate.fees, feePayment: estimate.feePayment, transferSpeed: estimate.transferSpeed, quote: estimate.quote },
      };
    },
    enabled: Boolean(!executionStarted && fromToken && toToken && address && debouncedAmount && debouncedAmount > 0n && fromChain.id !== toChain.id),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
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
  return { quote: query.data, isLoading: query.isLoading || debouncedAmount !== amount, isFetching: query.isFetching, isError: query.isError, error: query.error, simulationError: simulation.error, isSimulating: simulation.isLoading, simulationSucceeded: allowanceVerified && simulation.data === true, refetch: query.refetch, provider: 'Circle CCTP V2' };
}
