import { explorerTxUrl } from '../transactions';
import { isExplicitWalletRejection } from '../transactionRecovery';

export type ArcSwapCompletionState = 'idle' | 'pending' | 'executing' | 'confirming' | 'confirmed' | 'failed' | 'timeout' | 'rpc-error' | 'uncertain' | 'reverted';

export interface ArcSwapSuccessSummary {
  amountSold: string;
  inputToken: { symbol: string; color: string };
  amountReceived: string | null;
  actualReceivedVerified?: boolean;
  outputToken: { symbol: string; color: string };
  completedAt: number;
  expectedOutput?: string | null;
  minimumReceived?: string | null;
  providerFee?: string | null;
  gasPaid?: string | null;
  usdcBalanceBefore?: string | null;
  usdcBalanceAfter?: string | null;
  netUsdcBalanceChange?: string | null;
}

export interface PersistedArcSwapSuccess {
  walletAddress: string;
  transactionHash: string;
  dismissedAt: number | null;
  summary?: ArcSwapSuccessSummary;
}

interface ArcSwapSuccessReadResult {
  record: PersistedArcSwapSuccess | null;
  error: string | null;
}

const ARC_SWAP_SUCCESS_STORAGE_PREFIX = 'orbit:arc-swap-success:v1:';

function arcSwapSuccessStorageKey(walletAddress: string, transactionHash: string): string {
  return `${ARC_SWAP_SUCCESS_STORAGE_PREFIX}${walletAddress.toLowerCase()}:${transactionHash.toLowerCase()}`;
}

function isSuccessSummary(value: unknown): value is ArcSwapSuccessSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  const isToken = (token: unknown) =>
    Boolean(token) &&
    typeof token === 'object' &&
    typeof (token as Record<string, unknown>).symbol === 'string' &&
    typeof (token as Record<string, unknown>).color === 'string';
  return typeof summary.amountSold === 'string' &&
    isToken(summary.inputToken) &&
    (typeof summary.amountReceived === 'string' || summary.amountReceived === null) &&
    (summary.actualReceivedVerified === undefined || typeof summary.actualReceivedVerified === 'boolean') &&
    isToken(summary.outputToken) &&
    typeof summary.completedAt === 'number' &&
    Number.isFinite(summary.completedAt) &&
    ['expectedOutput', 'minimumReceived', 'providerFee', 'gasPaid', 'usdcBalanceBefore', 'usdcBalanceAfter', 'netUsdcBalanceChange']
      .every((field) => summary[field] === undefined || typeof summary[field] === 'string' || summary[field] === null);
}

export function readArcSwapSuccess(
  walletAddress: string,
  transactionHash: string,
): ArcSwapSuccessReadResult {
  if (typeof window === 'undefined') {
    return { record: null, error: 'Swap success storage is unavailable outside a browser session.' };
  }
  try {
    const serialized = window.localStorage.getItem(arcSwapSuccessStorageKey(walletAddress, transactionHash));
    if (serialized === null) return { record: null, error: null };
    const parsed: unknown = JSON.parse(serialized);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as Record<string, unknown>).walletAddress !== 'string' ||
      ((parsed as Record<string, unknown>).walletAddress as string).toLowerCase() !== walletAddress.toLowerCase() ||
      typeof (parsed as Record<string, unknown>).transactionHash !== 'string' ||
      ((parsed as Record<string, unknown>).transactionHash as string).toLowerCase() !== transactionHash.toLowerCase() ||
      !(
        isSuccessSummary((parsed as Record<string, unknown>).summary) ||
        (parsed as Record<string, unknown>).summary === undefined
      ) ||
      !(
        (parsed as Record<string, unknown>).dismissedAt === null ||
        typeof (parsed as Record<string, unknown>).dismissedAt === 'number'
      )
    ) {
      return { record: null, error: 'Saved Swap success details are invalid; the transaction record was preserved.' };
    }
    const record = parsed as PersistedArcSwapSuccess;
    if (record.summary && record.summary.actualReceivedVerified !== true) {
      return {
        record: {
          ...record,
          summary: {
            ...record.summary,
            amountReceived: null,
            actualReceivedVerified: false,
          },
        },
        error: null,
      };
    }
    if (
      record.summary &&
      (record.summary.usdcBalanceBefore === undefined || record.summary.usdcBalanceAfter === undefined)
    ) {
      return {
        record: {
          ...record,
          summary: {
            ...record.summary,
            usdcBalanceBefore: null,
            usdcBalanceAfter: null,
            netUsdcBalanceChange: null,
          },
        },
        error: null,
      };
    }
    return { record, error: null };
  } catch (caughtError) {
    return {
      record: null,
      error: caughtError instanceof Error
        ? `Swap success details could not be read: ${caughtError.message}`
        : 'Swap success details could not be read.',
    };
  }
}

function saveArcSwapSuccessRecord(
  walletAddress: string,
  transactionHash: string,
  summary: ArcSwapSuccessSummary | undefined,
  dismissedAt: number | null,
): Error | null {
  if (typeof window === 'undefined') return new Error('Swap success storage is unavailable.');
  const record: PersistedArcSwapSuccess = {
    walletAddress,
    transactionHash,
    ...(summary ? { summary } : {}),
    dismissedAt,
  };
  try {
    const key = arcSwapSuccessStorageKey(walletAddress, transactionHash);
    window.localStorage.setItem(key, JSON.stringify(record));
    const saved = window.localStorage.getItem(key);
    if (saved === null) return new Error('Swap success details were not saved.');
    const restored = readArcSwapSuccess(walletAddress, transactionHash);
    return restored.error || !restored.record
      ? new Error(restored.error ?? 'Swap success details could not be verified after saving.')
      : null;
  } catch (caughtError) {
    return caughtError instanceof Error
      ? caughtError
      : new Error('Swap success details could not be saved.');
  }
}

export function persistArcSwapSuccessSummary(
  walletAddress: string,
  transactionHash: string,
  summary: ArcSwapSuccessSummary,
): Error | null {
  const previous = readArcSwapSuccess(walletAddress, transactionHash);
  if (previous.error) return new Error(previous.error);
  return saveArcSwapSuccessRecord(
    walletAddress,
    transactionHash,
    summary,
    previous.record?.dismissedAt ?? null,
  );
}

export function persistArcSwapSuccessDismissal(
  walletAddress: string,
  transactionHash: string,
  summary?: ArcSwapSuccessSummary,
  dismissedAt = Date.now(),
): Error | null {
  const previous = readArcSwapSuccess(walletAddress, transactionHash);
  if (previous.error) return new Error(previous.error);
  return saveArcSwapSuccessRecord(
    walletAddress,
    transactionHash,
    summary ?? previous.record?.summary,
    previous.record?.dismissedAt ?? dismissedAt,
  );
}

export function isArcSwapSuccessDismissed(record: PersistedArcSwapSuccess | null | undefined): boolean {
  return record?.dismissedAt !== null && record?.dismissedAt !== undefined;
}

export function createArcSwapSuccessPopupActions(onDismiss: () => void) {
  return {
    onBack: onDismiss,
    onPrimary: onDismiss,
  };
}

export function getArcSwapCompletionTransition(
  state: ArcSwapCompletionState,
  transactionHash?: `0x${string}`,
  dismissed = false,
  acknowledgementLoaded = true,
) {
  if (state !== 'confirmed' || !transactionHash || dismissed || !acknowledgementLoaded) return null;
  return {
    returnToForm: true,
    transactionHash,
    explorerUrl: explorerTxUrl(transactionHash, 5042002),
  };
}

export function shouldHandleArcSwapCompletion(transactionHash: string, handledHash?: string) {
  return transactionHash !== handledHash;
}

export function dismissArcSwapSuccess(input: {
  persistDismissal: () => Error | null;
  resetExecution: () => void;
  setAmount: (amount: string) => void;
  setShowReview: (show: boolean) => void;
  setValidationError: (error: string | null) => void;
  clearQuoteSnapshot: () => void;
  clearCompletedAt: () => void;
  invalidateQuote: () => void;
}): Error | null {
  const persistenceError = input.persistDismissal();
  if (persistenceError) return persistenceError;
  input.resetExecution();
  input.setAmount('');
  input.setShowReview(false);
  input.setValidationError(null);
  input.clearQuoteSnapshot();
  input.clearCompletedAt();
  input.invalidateQuote();
  return null;
}

export async function resolveArcSwapWalletRejection(
  error: unknown,
  transactionHash: string | undefined,
  resolveHashlessRequest: () => Promise<Error | null>,
): Promise<{ handled: boolean; recoveryError?: Error }> {
  if (transactionHash || !isExplicitWalletRejection(error)) return { handled: false };
  const recoveryError = await resolveHashlessRequest();
  return recoveryError ? { handled: true, recoveryError } : { handled: true };
}

export function canSubmitArcSwap(state: ArcSwapCompletionState, inFlight: boolean) {
  return !inFlight && state !== 'pending' && state !== 'executing' && state !== 'confirming';
}

export function createArcSwapRunGuard() {
  let currentRun = 0;
  return {
    start() {
      currentRun += 1;
      return currentRun;
    },
    invalidate() {
      currentRun += 1;
    },
    isCurrent(run: number) {
      return run === currentRun;
    },
  };
}
