import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { BridgeKit, type BridgeResult } from '@circle-fin/bridge-kit';
import { CCTPV2BridgingProvider } from '@circle-fin/provider-cctp-v2';
import { parseUnits, type Address, type EIP1193Provider, type Hash } from 'viem';
import { ARC_PRIMARY_NETWORK, ETHEREUM_SEPOLIA, getOrbitNetwork } from '../../data/networks';
import { markArcForwardingTiming, timeArcForwardingAwait, type ArcForwardingTiming } from './arcForwardingTiming';

const kit = new BridgeKit();
const cctpProvider = new CCTPV2BridgingProvider();
export const CIRCLE_FORWARDING_CONFIG = { feePayment: 'destination' as const, transferSpeed: 'FAST' as const };
export type CircleForwardingStatus = { forwardState?: string | null; forwardTxHash?: string | null; eventNonce?: string; forwardErrorCode?: string | null; forwardErrorDetails?: string | null };
const forwarderProvider = cctpProvider as unknown as {
  fetchRelayerMint(source: unknown, transactionHash: string, config?: { timeout?: number; maxRetries?: number; retryDelay?: number }): Promise<CircleForwardingStatus>;
};
type CircleChain = 'Arc_Testnet' | 'Ethereum_Sepolia' | 'Base_Sepolia' | 'Arbitrum_Sepolia' | 'Optimism_Sepolia' | 'Avalanche_Fuji' | 'Polygon_Amoy_Testnet';
type CircleStep = { name: string; state: 'pending' | 'success' | 'error' | 'noop'; txHash?: string; errorMessage?: string; errorCategory?: string; forwarded?: boolean };
type CircleAdapter = Awaited<ReturnType<typeof createViemAdapterFromProvider>>;
type ForwardingCapabilityContext = { sourceChainId: number; destinationChainId: number };

const sdkChainById: Record<number, CircleChain> = {
  5042002: 'Arc_Testnet',
  11155111: 'Ethereum_Sepolia',
  84532: 'Base_Sepolia',
  421614: 'Arbitrum_Sepolia',
  11155420: 'Optimism_Sepolia',
  43113: 'Avalanche_Fuji',
  80002: 'Polygon_Amoy_Testnet',
};

function getSdkChain(chainId: number) {
  const sdkChain = sdkChainById[chainId];
  if (!sdkChain) return undefined;
  return kit.getSupportedChains({ chainType: 'evm', isTestnet: true }).find((chain) => chain.chain === sdkChain);
}

export function isCircleForwardingSupported(sourceChainId: number, destinationChainId: number) {
  const source = getSdkChain(sourceChainId);
  const destination = getSdkChain(destinationChainId);
  return Boolean(
    source?.cctp?.contracts.v2 &&
    destination?.cctp?.contracts.v2 &&
    destination.cctp.forwarderSupported?.destination === true,
  );
}

export function getForwardingPollRetryDelay(sourceChainId: number, destinationChainId: number) {
  return sourceChainId === ARC_PRIMARY_NETWORK.id && destinationChainId === ETHEREUM_SEPOLIA.id
    ? 1_000
    : undefined;
}

export function isFastArcSepoliaForwarding(sourceChainId: number, destinationChainId: number) {
  return getForwardingPollRetryDelay(sourceChainId, destinationChainId) !== undefined;
}

export interface CircleForwardingResult {
  sourceHash: Hash;
  destinationHash?: Hash;
  destinationAmount: bigint;
  totalSourceDebit: bigint;
  forwardingFee: bigint;
  protocolFee: bigint;
  feePayment: 'source' | 'destination';
  quote?: unknown;
  transferSpeed: string;
  pending: boolean;
  forwarding?: { forwardState?: string | null; forwardTxHash?: string | null; eventNonce?: string; forwardErrorCode?: string | null; forwardErrorDetails?: string | null };
  result: BridgeResult;
}

export class CircleForwardingError extends Error {
  sourceHash?: Hash;
  destinationHash?: Hash;
  result?: BridgeResult;
}

function describeBridgeResult(result: BridgeResult) {
  const rawResult = result as unknown as Record<string, unknown>;
  return {
    state: result.state,
    provider: result.provider,
    traceId: rawResult.traceId,
    source: result.source ? { address: result.source.address, chain: result.source.chain.chain } : undefined,
    destination: result.destination ? { address: result.destination.address, chain: result.destination.chain.chain } : undefined,
    steps: result.steps.map((step) => ({
      name: step.name,
      state: step.state,
      txHash: step.txHash,
      dataPresent: step.data !== undefined,
      error: step.error,
      errorMessage: step.errorMessage,
      errorCategory: step.errorCategory,
      forwarded: step.forwarded,
    })),
    error: rawResult.error,
    warnings: rawResult.warnings,
  };
}

function emitBridgeDiagnostic(result: BridgeResult, phase: 'bridge' | 'retry', input: { sourceChainId: number; destinationChainId: number; recipient: Address; amount: bigint }) {
  if (!import.meta.env.DEV) return;
  console.groupCollapsed(`[Orbit bridge] BridgeKit ${phase} result`);
  console.log({ sourceChainId: input.sourceChainId, destinationChainId: input.destinationChainId, recipient: input.recipient, amount: input.amount.toString() });
  console.log(describeBridgeResult(result));
  console.groupEnd();
}

function emitForwardingDiagnostic(phase: 'poll-start' | 'poll-complete' | 'poll-failed', input: { sourceChainId: number; destinationChainId: number; recipient: Address; amount: bigint }, forwarding?: { forwardState?: string | null; forwardTxHash?: string | null; eventNonce?: string; forwardErrorCode?: string | null; forwardErrorDetails?: string | null }, error?: unknown) {
  if (!import.meta.env.DEV) return;
  console.groupCollapsed(`[Orbit bridge] Circle forwarder ${phase}`);
  console.log({ sourceChainId: input.sourceChainId, destinationChainId: input.destinationChainId, recipient: input.recipient, amount: input.amount.toString(), forwardState: forwarding?.forwardState, forwardTxHash: forwarding?.forwardTxHash, forwardErrorCode: forwarding?.forwardErrorCode, forwardErrorDetails: forwarding?.forwardErrorDetails, error: error instanceof Error ? error.message : error });
  console.groupEnd();
}

function getCapabilityLookupDetails(chainId: number, capabilities: unknown) {
  if (!capabilities || typeof capabilities !== 'object') return { responseKeys: [], numericKeyPresent: false, hexKeyPresent: false, selectedKey: undefined };
  const record = capabilities as Record<string, unknown>;
  const numericKey = String(chainId);
  const hexKey = `0x${chainId.toString(16)}`;
  return {
    responseKeys: Object.keys(record),
    numericKeyPresent: Object.prototype.hasOwnProperty.call(record, numericKey),
    hexKeyPresent: Object.prototype.hasOwnProperty.call(record, hexKey),
    selectedKey: record[numericKey] !== undefined ? numericKey : record[hexKey] !== undefined ? hexKey : undefined,
  };
}

function instrumentForwardingAdapter(adapter: CircleAdapter, context: ForwardingCapabilityContext, timing?: ArcForwardingTiming) {
  if (!import.meta.env.DEV && !timing) return adapter;
  const diagnosticAdapter = adapter as CircleAdapter & {
    supportsAtomicBatch?: (chain: { chainId: number; chain?: string }) => Promise<boolean>;
    batchExecute?: (...args: unknown[]) => Promise<unknown>;
  };
  const instrumented = adapter as unknown as Record<string, unknown>;
  let sourceBurnSubmitted = false;
  const wrapTimedMethod = (name: string, label: string, matches?: (args: unknown[]) => boolean) => {
    const method = instrumented[name];
    if (!timing || typeof method !== 'function') return;
    instrumented[name] = async (...args: unknown[]) => {
      if (matches && !matches(args)) return (method as (...args: unknown[]) => Promise<unknown>).apply(adapter, args);
      const result = await timeArcForwardingAwait(timing, label, () => (method as (...args: unknown[]) => Promise<unknown>).apply(adapter, args));
      if (name === 'waitForTransaction') markArcForwardingTiming(timing, 'source receipt confirmed');
      return result;
    };
  };
  wrapTimedMethod('getAddress', 'wallet/account resolution');
  wrapTimedMethod('readAction', 'BridgeKit balance validation', (args) => args[0] === 'usdc.balanceOf');
  if (timing && typeof instrumented.prepareAction === 'function') {
    const prepareAction = instrumented.prepareAction as (...args: unknown[]) => Promise<Record<string, unknown>>;
    instrumented.prepareAction = async (...args: unknown[]) => {
      const action = String(args[0]);
      const isBridgePreparation = action.includes('increaseAllowance') || action.includes('depositForBurn');
      const request = isBridgePreparation
        ? await timeArcForwardingAwait(timing, `approval/burn preparation (${action})`, () => prepareAction.apply(adapter, args))
        : action === 'usdc.balanceOf'
          ? await timeArcForwardingAwait(timing, 'BridgeKit balance validation', () => prepareAction.apply(adapter, args))
        : await prepareAction.apply(adapter, args);
      if (typeof request.estimate === 'function') {
        const estimate = (request.estimate as (...estimateArgs: unknown[]) => Promise<unknown>).bind(request);
        request.estimate = (...estimateArgs: unknown[]) => timeArcForwardingAwait(timing, `gas estimation (${action})`, () => estimate(...estimateArgs));
      }
      if (typeof request.execute === 'function') {
        const execute = (request.execute as (...executeArgs: unknown[]) => Promise<unknown>).bind(request);
        request.execute = async (...executeArgs: unknown[]) => {
          const result = await timeArcForwardingAwait(timing, `transaction request (${action})`, () => execute(...executeArgs));
          if (action.includes('depositForBurn') && typeof result === 'string') {
            sourceBurnSubmitted = true;
            markArcForwardingTiming(timing, 'source tx hash available');
          }
          return result;
        };
      }
      return request;
    };
  }
  if (timing && typeof instrumented.waitForTransaction === 'function') {
    const waitForTransaction = instrumented.waitForTransaction as (...args: unknown[]) => Promise<unknown>;
    instrumented.waitForTransaction = async (...args: unknown[]) => {
      if (!sourceBurnSubmitted) return waitForTransaction.apply(adapter, args);
      try {
        const receipt = await timeArcForwardingAwait(timing, 'source receipt wait', () => waitForTransaction.apply(adapter, args));
        markArcForwardingTiming(timing, 'source receipt confirmed');
        return receipt;
      } finally {
        sourceBurnSubmitted = false;
      }
    };
  }
  if (typeof diagnosticAdapter.supportsAtomicBatch === 'function') {
    const supportsAtomicBatch = diagnosticAdapter.supportsAtomicBatch.bind(adapter);
    diagnosticAdapter.supportsAtomicBatch = async (chain) => {
      try {
        const supported = await timeArcForwardingAwait(timing, 'wallet_getCapabilities', () => supportsAtomicBatch(chain));
        console.debug('[Orbit bridge] forwarding capability decision', {
          ...context,
          walletClientChainId: chain.chainId,
          walletClientChain: chain.chain,
          supportsAtomicBatch: supported,
          adapterBatchExecuteExists: typeof diagnosticAdapter.batchExecute === 'function',
        });
        return supported;
      } catch (error) {
        console.debug('[Orbit bridge] forwarding capability decision failed', {
          ...context,
          walletClientChainId: chain.chainId,
          walletClientChain: chain.chain,
          supportsAtomicBatch: false,
          adapterBatchExecuteExists: typeof diagnosticAdapter.batchExecute === 'function',
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }
  if (typeof diagnosticAdapter.batchExecute === 'function' && timing) {
    const batchExecute = diagnosticAdapter.batchExecute.bind(adapter);
    diagnosticAdapter.batchExecute = (async (...args: unknown[]) => {
      const result = await timeArcForwardingAwait(timing, 'approval/burn batch execution', () => batchExecute(...args));
      return result;
    }) as typeof diagnosticAdapter.batchExecute;
  }
  return adapter;
}

function getForwardingData(result: BridgeResult) {
  for (const step of [...result.steps].reverse()) {
    const data = (step as unknown as { data?: unknown }).data;
    if (data && typeof data === 'object' && ('forwardState' in data || 'forwardTxHash' in data)) {
      return data as { forwardState?: string | null; forwardTxHash?: string | null; eventNonce?: string; forwardErrorCode?: string | null; forwardErrorDetails?: string | null };
    }
  }
  return undefined;
}

export function isForwardingPendingResult(result: Pick<BridgeResult, 'state' | 'steps'>) {
  const burn = result.steps.find((step) => step.name.toLowerCase() === 'burn');
  const mint = result.steps.find((step) => step.name.toLowerCase() === 'mint');
  return Boolean(result.state === 'pending' && burn?.state === 'success' && (!mint || mint.state === 'pending'));
}

function getStep(result: BridgeResult, name: string) {
  return [...result.steps].reverse().find((step) => step.name.toLowerCase() === name.toLowerCase());
}

export function getForwardingFailureDetail(result: Pick<BridgeResult, 'steps'> & { error?: unknown }) {
  const step = [...result.steps].reverse().find((candidate) => candidate.state === 'error');
  const formatError = (error: unknown) => {
    if (!error) return undefined;
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try { return JSON.stringify(error); } catch { return String(error); }
  };
  const stepError = step?.errorMessage ?? formatError(step?.error);
  return stepError ?? formatError(result.error) ?? 'BridgeKit returned an incomplete forwarding result';
}

export function createCircleForwardingParams(input: { sourceChainId: number; destinationChainId: number; recipient: Address; amount: bigint }, adapter: CircleAdapter) {
  return {
    from: { adapter, chain: sdkChainById[input.sourceChainId] },
    to: { chain: sdkChainById[input.destinationChainId], recipientAddress: input.recipient, useForwarder: true },
    amount: `${input.amount / 1_000_000n}.${(input.amount % 1_000_000n).toString().padStart(6, '0')}`,
    token: 'USDC',
    config: getCircleForwardingConfig(input.sourceChainId),
  } as const;
}

export interface CircleForwardingEstimate {
  fees: readonly { type: string; amount: string | null; token: string }[];
  forwardingFee: bigint;
  protocolFee: bigint;
  totalFee: bigint;
  destinationAmount: bigint;
  totalSourceDebit: bigint;
  feePayment: 'source' | 'destination';
  quote?: unknown;
  transferSpeed: string;
}

export function calculateForwardingQuoteAmounts(input: { amount: bigint; totalFee: bigint; feePayment: 'source' | 'destination'; amountReceived?: string; totalDebit?: string }) {
  const destinationAmount = input.feePayment === 'source' && input.amountReceived
    ? parseUnits(input.amountReceived, 6)
    : input.amount > input.totalFee ? input.amount - input.totalFee : 0n;
  const totalSourceDebit = input.feePayment === 'source' && input.totalDebit ? parseUnits(input.totalDebit, 6) : input.amount;
  return { destinationAmount, totalSourceDebit };
}

export async function estimateCircleForwarding(input: { provider: EIP1193Provider; sourceChainId: number; destinationChainId: number; recipient: Address; amount: bigint }, onDiagnostic?: (stage: 'createViemAdapterFromProvider' | 'estimateCircleForwarding', error: unknown) => void): Promise<CircleForwardingEstimate> {
  let adapter: CircleAdapter;
  try {
    adapter = await createViemAdapterFromProvider({ provider: withWalletRequestDiagnostics(input.provider) });
  } catch (error) {
    onDiagnostic?.('createViemAdapterFromProvider', error);
    throw error;
  }
  let estimate: Awaited<ReturnType<typeof kit.estimate>>;
  try {
    estimate = await kit.estimate(createCircleForwardingParams(input, adapter));
  } catch (error) {
    onDiagnostic?.('estimateCircleForwarding', error);
    throw error;
  }
  const fees = estimate.fees.map((fee) => ({ type: fee.type, amount: fee.amount, token: fee.token }));
  const toUnits = (amount: string | null) => amount ? parseUnits(amount, 6) : 0n;
  const estimateRecord = estimate as typeof estimate & { amountReceived?: string; totalDebit?: string; feeTotal?: string; feeItems?: readonly { type: string; amount: string }[]; quote?: unknown };
  const authoritativeFees = estimateRecord.feeItems?.map((fee) => ({ type: fee.type, amount: fee.amount, token: 'USDC' })) ?? fees;
  const forwardingFee = authoritativeFees.filter((fee) => fee.type === 'FORWARD' || fee.type === 'forwarder').reduce((total, fee) => total + toUnits(fee.amount), 0n);
  const protocolFee = authoritativeFees.filter((fee) => fee.type !== 'FORWARD' && fee.type !== 'forwarder').reduce((total, fee) => total + toUnits(fee.amount), 0n);
  const totalFee = forwardingFee + protocolFee;
  const sourcePaid = getCircleForwardingConfig(input.sourceChainId).feePayment === 'source';
  const { destinationAmount, totalSourceDebit } = calculateForwardingQuoteAmounts({ amount: input.amount, totalFee, feePayment: sourcePaid ? 'source' : 'destination', amountReceived: estimateRecord.amountReceived, totalDebit: estimateRecord.totalDebit });
  return { fees: authoritativeFees, forwardingFee, protocolFee, totalFee, destinationAmount, totalSourceDebit, feePayment: sourcePaid ? 'source' : 'destination', quote: estimateRecord.quote, transferSpeed: getCircleForwardingConfig(input.sourceChainId).transferSpeed };
}

export function getWalletRequestDiagnostic(args: { method: string; params?: unknown }) {
  const params = Array.isArray(args.params) ? args.params : [];
  const first = params[0] as Record<string, unknown> | undefined;
  const transaction = first && typeof first === 'object' && ('to' in first || 'data' in first || 'value' in first) ? first : undefined;
  const domain = first && typeof first === 'object' && 'domain' in first ? first.domain as Record<string, unknown> : undefined;
  return {
    method: args.method,
    chainId: transaction?.chainId ?? domain?.chainId,
    from: transaction?.from,
    to: transaction?.to,
    value: transaction?.value,
    dataSelector: typeof transaction?.data === 'string' ? transaction.data.slice(0, 10) : undefined,
    gas: transaction ? { gas: transaction.gas, gasPrice: transaction.gasPrice, maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas } : undefined,
    typedData: domain ? { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract, primaryType: first?.primaryType } : undefined,
  };
}

function withWalletRequestDiagnostics(provider: EIP1193Provider, context?: ForwardingCapabilityContext, timing?: ArcForwardingTiming): EIP1193Provider {
  if (!import.meta.env.DEV && !timing) return provider;
  return {
    ...provider,
    request: async (args) => {
      if (import.meta.env.DEV) console.debug('[Orbit bridge] wallet request', getWalletRequestDiagnostic(args));
      const isSubmission = args.method === 'wallet_sendCalls' || args.method === 'eth_sendTransaction' || args.method === 'eth_sendRawTransaction';
      if (timing && isSubmission) markArcForwardingTiming(timing, `${args.method} invoked`);
      const request = () => provider.request(args as never);
      const response = timing && args.method === 'wallet_getCapabilities'
        ? await timeArcForwardingAwait(timing, 'wallet_getCapabilities request', request)
        : timing && args.method === 'wallet_getCallsStatus'
          ? await timeArcForwardingAwait(timing, 'wallet_getCallsStatus', request)
        : timing && isSubmission
          ? await timeArcForwardingAwait(timing, `${args.method} wallet request`, request)
          : await request();
      if (timing && isSubmission) markArcForwardingTiming(timing, 'wallet request resolved');
      if (timing && args.method === 'wallet_getCallsStatus' && response && typeof response === 'object' && 'receipts' in response) {
        const receipts = (response as { receipts?: unknown }).receipts;
        if (Array.isArray(receipts) && receipts.some((receipt) => receipt && typeof receipt === 'object' && ('transactionHash' in receipt || 'txHash' in receipt))) {
          markArcForwardingTiming(timing, 'source tx hash available');
        }
      }
      if (args.method === 'wallet_getCapabilities' && context) {
        console.debug('[Orbit bridge] wallet_getCapabilities response', {
          ...context,
          walletClientChainId: context.sourceChainId,
          capabilityLookup: getCapabilityLookupDetails(context.sourceChainId, response),
          capabilities: response,
        });
      }
      if (args.method === 'wallet_sendCalls' && context) {
        console.debug('[Orbit bridge] wallet_sendCalls observed', context);
      }
      return response;
    },
  };
}

export async function executeCircleForwarding(input: {
  provider: EIP1193Provider;
  sourceChainId: number;
  destinationChainId: number;
  recipient: Address;
  amount: bigint;
  quote?: unknown;
  destinationAmount?: bigint;
  totalSourceDebit?: bigint;
  timing?: ArcForwardingTiming;
  onStep?: (step: CircleStep) => void;
}): Promise<CircleForwardingResult> {
  const sourceChain = getSdkChain(input.sourceChainId);
  const destinationChain = getSdkChain(input.destinationChainId);
  if (!sourceChain || !destinationChain || !isCircleForwardingSupported(input.sourceChainId, input.destinationChainId)) {
    throw new Error('Circle forwarding is unavailable for this route');
  }

  const retryDelay = getForwardingPollRetryDelay(input.sourceChainId, input.destinationChainId);
  const executionKit = retryDelay === undefined ? kit : new BridgeKit();
  if (retryDelay !== undefined) {
    const forwardingProvider = executionKit.providers[0] as unknown as {
      fetchRelayerMint: (source: unknown, transactionHash: string, config?: { timeout?: number; maxRetries?: number; retryDelay?: number }) => Promise<unknown>;
    };
    const fetchRelayerMint = forwardingProvider.fetchRelayerMint.bind(forwardingProvider);
    forwardingProvider.fetchRelayerMint = async (source, transactionHash, config) => {
      const forwarding = await timeArcForwardingAwait(input.timing, 'Circle forwarding status request', () => fetchRelayerMint(source, transactionHash, { ...config, retryDelay })) as CircleForwardingStatus;
      markArcForwardingTiming(input.timing, 'Circle status response received');
      if (forwarding.forwardTxHash) markArcForwardingTiming(input.timing, 'destination hash received');
      return forwarding;
    };
  }

  const context = { sourceChainId: input.sourceChainId, destinationChainId: input.destinationChainId };
  const adapter = instrumentForwardingAdapter(
    await timeArcForwardingAwait(input.timing, 'Circle adapter creation', () => createViemAdapterFromProvider({ provider: withWalletRequestDiagnostics(input.provider, context, input.timing) })),
    context,
    input.timing,
  );
  const bridgeParams = createCircleForwardingParams(input, adapter);
  const estimate = input.quote ? undefined : await kit.estimate(bridgeParams);
  const estimateRecord = estimate as (typeof estimate & { amountReceived?: string; totalDebit?: string; quote?: unknown }) | undefined;
  const destinationAmount = input.destinationAmount ?? (estimateRecord?.amountReceived ? parseUnits(estimateRecord.amountReceived, 6) : calculateForwardedDestinationAmount(input.amount, estimateRecord?.fees.map((fee) => fee.amount) ?? []));
  const totalSourceDebit = input.totalSourceDebit ?? (estimateRecord?.totalDebit ? parseUnits(estimateRecord.totalDebit, 6) : input.amount);
  const executionFees = estimateRecord?.fees ?? [];
  const forwardingFee = executionFees.filter((fee) => fee.type === 'forwarder').reduce((total, fee) => total + (fee.amount ? parseUnits(fee.amount, 6) : 0n), 0n);
  const protocolFee = executionFees.filter((fee) => fee.type !== 'forwarder').reduce((total, fee) => total + (fee.amount ? parseUnits(fee.amount, 6) : 0n), 0n);
  const eventKit = executionKit as unknown as { on(action: string, handler: (payload: unknown) => void): void; off(action: string, handler: (payload: unknown) => void): void };
  const handleBurn = (payload: unknown) => {
    const step = (payload as { values: CircleStep }).values;
    if (step.state === 'success' && step.txHash) {
      markArcForwardingTiming(input.timing, 'source receipt confirmed');
    }
    input.onStep?.(step);
  };
  const handleAttestation = (payload: unknown) => input.onStep?.((payload as { values: CircleStep }).values);
  const handleMint = (payload: unknown) => input.onStep?.((payload as { values: CircleStep }).values);
  eventKit.on('burn', handleBurn);
  eventKit.on('fetchAttestation', handleAttestation);
  eventKit.on('mint', handleMint);
  let result: BridgeResult;
  const originalFetch = globalThis.fetch;
  if (input.timing) {
    globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      if (!url.includes('/v2/burn/USDC/fees/26/0')) return originalFetch.call(globalThis, request, init);
      const feeName = url.includes('forward=true') ? 'forwarding fee request' : 'FAST burn fee request';
      return timeArcForwardingAwait(input.timing, feeName, () => originalFetch.call(globalThis, request, init));
    }) as typeof fetch;
  }
  try {
    result = await executionKit.bridge(input.quote ? { ...bridgeParams, quote: input.quote } : estimateRecord?.quote ? { ...bridgeParams, quote: estimateRecord.quote } : bridgeParams);
  } finally {
    if (input.timing) globalThis.fetch = originalFetch;
    eventKit.off('burn', handleBurn);
    eventKit.off('fetchAttestation', handleAttestation);
    eventKit.off('mint', handleMint);
  }
  emitBridgeDiagnostic(result, 'bridge', input);
  result.steps.forEach((step) => input.onStep?.(step));

  const sourceHash = getStep(result, 'burn')?.txHash;
  const mint = getStep(result, 'mint');
  let forwarding = getForwardingData(result);
  let destinationHash = (mint?.txHash ?? forwarding?.forwardTxHash) as Hash | undefined;
  if (forwarding) markArcForwardingTiming(input.timing, 'Circle status response received');
  if (destinationHash) markArcForwardingTiming(input.timing, 'destination hash received');
  if (sourceHash && !verifyCircleForwardingResult({
    result,
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    recipient: input.recipient,
    expectedNetAmount: destinationAmount,
    forwarding,
  })) {
    const forwardingError = forwarding && getForwardingTerminalError(forwarding);
    if (forwardingError) {
      const error = new CircleForwardingError(`Circle forwarding failed: ${forwardingError}`);
      error.sourceHash = sourceHash as Hash;
      error.destinationHash = destinationHash;
      error.result = result;
      throw error;
    }
    emitForwardingDiagnostic('poll-start', input, forwarding);
    try {
      forwarding = await timeArcForwardingAwait(input.timing, 'Circle forwarding status request', () => forwarderProvider.fetchRelayerMint({ adapter, chain: sourceChain, address: input.recipient }, sourceHash, retryDelay === undefined ? undefined : { retryDelay }));
      emitForwardingDiagnostic('poll-complete', input, forwarding);
      destinationHash = (forwarding.forwardTxHash ?? destinationHash) as Hash | undefined;
      markArcForwardingTiming(input.timing, 'Circle status response received');
      if (destinationHash) markArcForwardingTiming(input.timing, 'destination hash received');
    } catch (caughtError) {
      emitForwardingDiagnostic('poll-failed', input, forwarding, caughtError);
      const error = new CircleForwardingError(`Circle forwarding failed: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`);
      error.sourceHash = sourceHash as Hash;
      error.destinationHash = destinationHash;
      error.result = result;
      throw error;
    }
  }
  if (sourceHash && forwarding?.forwardState && !isForwardingDeliveryReady(forwarding)) {
    return { sourceHash: sourceHash as Hash, destinationHash, destinationAmount, totalSourceDebit, forwardingFee, protocolFee, feePayment: getCircleForwardingConfig(input.sourceChainId).feePayment, quote: input.quote ?? estimateRecord?.quote, transferSpeed: getCircleForwardingConfig(input.sourceChainId).transferSpeed, pending: true, forwarding, result };
  }
  if (!sourceHash || !verifyCircleForwardingResult({
    result,
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    recipient: input.recipient,
    expectedNetAmount: destinationAmount,
    forwarding,
  })) {
    const detail = getForwardingFailureDetail(result);
    const error = new CircleForwardingError(`Circle forwarding failed: ${detail}`);
    error.sourceHash = sourceHash as Hash | undefined;
    error.destinationHash = destinationHash;
    error.result = result;
    throw error;
  }

  return { sourceHash: sourceHash as Hash, destinationHash, destinationAmount, totalSourceDebit, forwardingFee, protocolFee, feePayment: getCircleForwardingConfig(input.sourceChainId).feePayment, quote: input.quote ?? estimateRecord?.quote, transferSpeed: getCircleForwardingConfig(input.sourceChainId).transferSpeed, pending: false, forwarding, result };
}
export function calculateForwardedDestinationAmount(amount: bigint, fees: readonly (string | null)[]) {
  const totalFees = fees.reduce((total, fee) => total + (fee ? parseUnits(fee, 6) : 0n), 0n);
  return amount > totalFees ? amount - totalFees : 0n;
}
export function forwardingRouteLabel(sourceChainId: number, destinationChainId: number) {
  return isCircleForwardingSupported(sourceChainId, destinationChainId)
    ? 'Circle forwarding destination'
    : 'User-signed destination mint';
}

export function getForwardingDestination(sourceChainId: number, destinationChainId: number) {
  return isCircleForwardingSupported(sourceChainId, destinationChainId)
    ? getOrbitNetwork(destinationChainId)
    : undefined;
}

export function isForwardingRetryableResult(result: Pick<BridgeResult, 'state' | 'steps'>) {
  if (result.state !== 'error') return false;
  const mint = [...result.steps].reverse().find((step) => step.name.toLowerCase() === 'mint');
  const recoverability = mint?.error && typeof mint.error === 'object' && 'recoverability' in mint.error
    ? String((mint.error as { recoverability?: unknown }).recoverability)
    : '';
  return recoverability === 'RETRYABLE' || recoverability === 'RESUMABLE';
}

export function verifyCircleForwardingResult(input: {
  result: BridgeResult;
  sourceChainId: number;
  destinationChainId: number;
  recipient: Address;
  expectedNetAmount: bigint;
  forwarding?: { forwardState?: string | null; forwardTxHash?: string | null };
}) {
  const destination = input.result.destination;
  const mint = [...input.result.steps].reverse().find((step) => step.name.toLowerCase() === 'mint');
  const destinationChain = sdkChainById[input.destinationChainId];
  const hasForwardingConfirmation = input.forwarding?.forwardState === 'CONFIRMED' || input.forwarding?.forwardState === 'COMPLETE';
  const hasSuccessfulMintEvidence = Boolean((mint?.state === 'success' && (mint.forwarded === true || Boolean(mint.txHash))) || input.forwarding?.forwardTxHash || hasForwardingConfirmation);
  return Boolean(
    (input.result.state === 'success' || hasForwardingConfirmation || Boolean(input.forwarding?.forwardTxHash)) &&
    input.result.source.chain.chain === sdkChainById[input.sourceChainId] &&
    destination.chain.chain === destinationChain &&
    destination.address.toLowerCase() === input.recipient.toLowerCase() &&
    hasSuccessfulMintEvidence &&
    input.expectedNetAmount > 0n,
  );
}

export function isForwardingDeliveryReady(forwarding: { forwardState?: string | null; forwardTxHash?: string | null }) {
  return forwarding.forwardState === 'CONFIRMED' || forwarding.forwardState === 'COMPLETE' || Boolean(forwarding.forwardTxHash);
}

export function isAuthoritativeForwardingSuccess(forwarding: { forwardState?: string | null; forwardTxHash?: string | null }) {
  return Boolean(forwarding.forwardTxHash) || forwarding.forwardState === 'CONFIRMED' || forwarding.forwardState === 'COMPLETE';
}

export function getForwardingStatusOutcome(forwardState?: string | null, forwardTxHash?: string | null): 'pending' | 'completed' | 'failed' {
  if (forwardState === 'FAILED') return 'failed';
  if (forwardTxHash || forwardState === 'CONFIRMED' || forwardState === 'COMPLETE') return 'completed';
  return 'pending';
}

export async function pollCircleForwardingStatus(input: { provider: EIP1193Provider; sourceChainId: number; sourceHash: Hash; recipient: Address; timeoutMs?: number; pollingConfig?: { timeout?: number; maxRetries?: number; retryDelay?: number }; timing?: ArcForwardingTiming }) {
  const sourceChain = getSdkChain(input.sourceChainId);
  if (!sourceChain) throw new Error('Circle forwarding source network is unavailable');
  const adapter = await timeArcForwardingAwait(input.timing, 'status adapter creation', () => createViemAdapterFromProvider({ provider: withWalletRequestDiagnostics(input.provider, undefined, input.timing) }));
  const timeoutMs = input.timeoutMs ?? 15_000;
  let timer: number | undefined;
  try {
    return await Promise.race([
      timeArcForwardingAwait(input.timing, 'Circle forwarding status request', () => forwarderProvider.fetchRelayerMint({ adapter, chain: sourceChain, address: input.recipient }, input.sourceHash, input.pollingConfig)),
      new Promise<undefined>((resolve) => { timer = window.setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export function getForwardingTerminalError(forwarding: { forwardState?: string | null; forwardErrorCode?: string | null; forwardErrorDetails?: string | null }) {
  if (forwarding.forwardState !== 'FAILED') return undefined;
  return [forwarding.forwardErrorCode, forwarding.forwardErrorDetails].filter(Boolean).join(': ') || 'Circle forwarder reported FAILED';
}

function isSourceFeeSupported(chainId: number) {
  return kit.getSupportedChains({ chainType: 'evm', isTestnet: true, sourceFeeSupported: true }).some((chain) => chain.chain === sdkChainById[chainId]);
}

export function isCircleForwardingSourceFeeSupported(sourceChainId: number) {
  return isSourceFeeSupported(sourceChainId);
}

export function getCircleForwardingConfig(sourceChainId: number) {
  return isSourceFeeSupported(sourceChainId)
    ? { feePayment: 'source' as const, transferSpeed: 'FAST' as const }
    : CIRCLE_FORWARDING_CONFIG;
}

export function getCircleForwardingApprovalAmount(sourceChainId: number, amount: bigint | null, totalDebit?: bigint | null) {
  if (amount === null || amount <= 0n) return 0n;
  return getCircleForwardingConfig(sourceChainId).feePayment === 'source' ? (totalDebit ?? amount) : amount;
}

export function getCircleForwardingApprovalTarget(sourceChainId: number): Address | null {
  const source = getSdkChain(sourceChainId);
  const contracts = source?.cctp?.contracts.v2;
  if (!contracts) return null;
  const addresses = contracts as typeof contracts & { tokenMessenger?: Address; tokenMessengerWithFees?: Address };
  return (getCircleForwardingConfig(sourceChainId).feePayment === 'source' ? addresses.tokenMessengerWithFees : addresses.tokenMessenger) ?? null;
}