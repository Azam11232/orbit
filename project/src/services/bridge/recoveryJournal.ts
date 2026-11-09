import type { Address, Hash } from 'viem';
import { getOrbitNetwork, isCctpRouteSupported } from '../../data/networks';
import type { BridgeQuote, BridgeToken } from '../../types/bridge';

export type BridgeRecoveryJournalStatus =
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

export type BridgeDestinationSubmissionState =
  | 'not-submitted'
  | 'submission-pending'
  | 'submitted'
  | 'confirmed'
  | 'submission-unknown';

export interface BridgeRecoveryJournalEntry {
  walletAddress: Address;
  sourceChainId: number;
  destinationChainId: number;
  route: 'forwarding' | 'cctp';
  amount: string;
  destinationAmount: string;
  recipientAddress?: Address;
  sourceTarget?: Address;
  feePayment?: 'source' | 'destination';
  sourceHash: Hash;
  destinationHash?: Hash;
  destinationSubmissionState?: BridgeDestinationSubmissionState;
  status: BridgeRecoveryJournalStatus;
  error?: string;
  updatedAt: number;
}

const STORAGE_KEY_PREFIX = 'orbit:bridge-recovery:v2';

function isAddress(value: string): boolean {
  return /^0x[a-f\d]{40}$/i.test(value);
}

function isHash(value: string): boolean {
  return /^0x[a-f\d]{64}$/i.test(value);
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && BigInt(value) > 0n;
}

function isJournalStatus(value: unknown): value is BridgeRecoveryJournalStatus {
  return typeof value === 'string' && [
    'preflight',
    'source-pending',
    'source-confirmed',
    'attestation-pending',
    'attestation-ready',
    'destination-pending',
    'completed',
    'needs-attention',
    'error',
    'cancelled',
  ].includes(value);
}

function isDestinationSubmissionState(value: unknown): value is BridgeDestinationSubmissionState {
  return value === 'not-submitted' ||
    value === 'submission-pending' ||
    value === 'submitted' ||
    value === 'confirmed' ||
    value === 'submission-unknown';
}

function getStorageKey(walletAddress: Address, sourceHash: Hash) {
  return `${STORAGE_KEY_PREFIX}:${walletAddress.toLowerCase()}:${sourceHash.toLowerCase()}`;
}

function isJournalEntry(value: unknown): value is BridgeRecoveryJournalEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<BridgeRecoveryJournalEntry>;
  return isAddress(entry.walletAddress ?? '') &&
    isHash(entry.sourceHash ?? '') &&
  (entry.recipientAddress === undefined || isAddress(entry.recipientAddress)) &&
  (entry.sourceTarget === undefined || isAddress(entry.sourceTarget)) &&
    (entry.destinationHash === undefined || isHash(entry.destinationHash)) &&
  (entry.destinationSubmissionState === undefined || isDestinationSubmissionState(entry.destinationSubmissionState)) &&
    (entry.route === 'forwarding' || entry.route === 'cctp') &&
    isJournalStatus(entry.status) &&
    Number.isSafeInteger(entry.sourceChainId) &&
    Number.isSafeInteger(entry.destinationChainId) &&
    entry.sourceChainId! > 0 &&
    entry.destinationChainId! > 0 &&
    entry.sourceChainId !== entry.destinationChainId &&
    isPositiveInteger(entry.amount ?? '') &&
    isPositiveInteger(entry.destinationAmount ?? '') &&
    Number.isFinite(entry.updatedAt) &&
    (entry.feePayment === undefined || entry.feePayment === 'source' || entry.feePayment === 'destination');
}

export function readLatestBridgeRecoveryJournalEntry(walletAddress: Address): {
  entry?: BridgeRecoveryJournalEntry;
  error?: Error;
} {
  try {
    if (typeof window === 'undefined') throw new Error('Bridge recovery storage is unavailable.');
    if (!isAddress(walletAddress)) throw new Error('Bridge recovery wallet address is invalid.');
    const walletPrefix = `${STORAGE_KEY_PREFIX}:${walletAddress.toLowerCase()}:`;
    const entries: BridgeRecoveryJournalEntry[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(walletPrefix)) continue;
      const stored = window.localStorage.getItem(key);
      if (!stored) continue;
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 2 || !('entry' in parsed)) {
        if (!isJournalEntry(parsed)) continue;
      }
      const candidate = 'entry' in parsed ? parsed.entry : parsed;
      if (
        !isJournalEntry(candidate) ||
        candidate.walletAddress.toLowerCase() !== walletAddress.toLowerCase() ||
        getStorageKey(candidate.walletAddress, candidate.sourceHash) !== key ||
        candidate.route !== 'cctp' ||
        candidate.status === 'completed' ||
        candidate.status === 'cancelled'
      ) continue;
      entries.push(candidate);
    }
    return { entry: entries.sort((left, right) => right.updatedAt - left.updatedAt)[0] };
  } catch (caughtError) {
    return {
      error: caughtError instanceof Error
        ? caughtError
        : new Error('Bridge recovery details could not be read.'),
    };
  }
}

export function createRecoveredCctpBridgeQuote(entry: BridgeRecoveryJournalEntry): BridgeQuote | null {
  if (entry.route !== 'cctp' || !isCctpRouteSupported(entry.sourceChainId, entry.destinationChainId)) return null;
  const source = getOrbitNetwork(entry.sourceChainId);
  const destination = getOrbitNetwork(entry.destinationChainId);
  if (
    !source ||
    !destination ||
    entry.sourceTarget && entry.sourceTarget.toLowerCase() !== source.tokenMessengerV2.toLowerCase()
  ) return null;
  const sourceToken: BridgeToken = {
    chainId: source.id,
    address: source.usdc,
    symbol: 'USDC',
    name: `${source.name} USDC`,
    decimals: 6,
    logoURI: source.logo,
    isNative: false,
  };
  const destinationToken: BridgeToken = {
    chainId: destination.id,
    address: destination.usdc,
    symbol: 'USDC',
    name: `${destination.name} USDC`,
    decimals: 6,
    logoURI: destination.logo,
    isNative: false,
  };
  const fromAmount = BigInt(entry.amount);
  const toAmount = BigInt(entry.destinationAmount);
  return {
    id: `recovered-cctp-${entry.sourceHash}`,
    provider: 'Circle CCTP V2',
    fromChain: { id: source.id, name: source.name },
    toChain: { id: destination.id, name: destination.name },
    fromToken: sourceToken,
    toToken: destinationToken,
    recipientAddress: entry.recipientAddress ?? entry.walletAddress,
    fromAmount,
    toAmount,
    toAmountMin: toAmount,
    feeAmount: null,
    feePayment: entry.feePayment,
    selectedRoute: 'cctp',
    gasAmount: null,
    gasCosts: [],
    executionDurationSeconds: null,
    transactionTarget: source.tokenMessengerV2,
    transactionData: null,
    transactionValue: 0n,
    bridge: 'Circle CCTP V2',
    quotedAt: entry.updatedAt,
    raw: null,
  };
}

export function createBridgeRecoveryJournalEntry(
  quote: BridgeQuote,
  walletAddress: Address,
  sourceHash: Hash,
  status: BridgeRecoveryJournalStatus,
  options: {
    destinationHash?: Hash;
    destinationSubmissionState?: BridgeDestinationSubmissionState;
    error?: string;
    updatedAt?: number;
  } = {},
): BridgeRecoveryJournalEntry {
  if (!isAddress(walletAddress) || !isHash(sourceHash)) {
    throw new Error('Bridge recovery journal context is invalid.');
  }
  if (
    !Number.isSafeInteger(quote.fromChain.id) ||
    !Number.isSafeInteger(quote.toChain.id) ||
    quote.fromChain.id <= 0 ||
    quote.toChain.id <= 0 ||
    quote.fromChain.id === quote.toChain.id ||
    quote.fromAmount <= 0n ||
    (quote.toAmount ?? quote.fromAmount) <= 0n
  ) {
    throw new Error('Bridge recovery journal quote is invalid.');
  }
  return {
    walletAddress,
    sourceChainId: quote.fromChain.id,
    destinationChainId: quote.toChain.id,
    route: quote.selectedRoute ?? 'cctp',
    amount: quote.fromAmount.toString(),
    destinationAmount: (quote.toAmount ?? quote.fromAmount).toString(),
    recipientAddress: quote.recipientAddress ?? walletAddress,
    sourceTarget: quote.transactionTarget ?? getOrbitNetwork(quote.fromChain.id)?.tokenMessengerV2 ?? walletAddress,
    ...(quote.feePayment ? { feePayment: quote.feePayment } : {}),
    sourceHash,
    ...(options.destinationHash ? { destinationHash: options.destinationHash } : {}),
    destinationSubmissionState: options.destinationSubmissionState ??
      (options.destinationHash ? 'submitted' : 'not-submitted'),
    status,
    ...(options.error ? { error: options.error } : {}),
    updatedAt: options.updatedAt ?? Date.now(),
  };
}

export function saveBridgeRecoveryJournalEntry(entry: BridgeRecoveryJournalEntry): Error | null {
  try {
    if (typeof window === 'undefined') throw new Error('Bridge recovery storage is unavailable.');
    if (
      !isAddress(entry.walletAddress) ||
      !isHash(entry.sourceHash) ||
      !isAddress(entry.recipientAddress ?? entry.walletAddress) ||
      !isAddress(entry.sourceTarget ?? getOrbitNetwork(entry.sourceChainId)?.tokenMessengerV2 ?? '') ||
      (entry.destinationHash !== undefined && !isHash(entry.destinationHash)) ||
      (entry.destinationSubmissionState !== undefined && !isDestinationSubmissionState(entry.destinationSubmissionState)) ||
      !Number.isSafeInteger(entry.sourceChainId) ||
      !Number.isSafeInteger(entry.destinationChainId) ||
      entry.sourceChainId <= 0 ||
      entry.destinationChainId <= 0 ||
      entry.sourceChainId === entry.destinationChainId ||
      !isPositiveInteger(entry.amount) ||
      !isPositiveInteger(entry.destinationAmount)
    ) {
      throw new Error('Bridge recovery journal entry is invalid.');
    }
    window.localStorage.setItem(
      getStorageKey(entry.walletAddress, entry.sourceHash),
      JSON.stringify({ version: 2, ...entry }),
    );
    return null;
  } catch (caughtError) {
    return caughtError instanceof Error
      ? caughtError
      : new Error('Bridge recovery details could not be saved.');
  }
}
