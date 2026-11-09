import { describe, expect, it, vi } from 'vitest';
import {
  canSubmitArcSwap,
  createArcSwapRunGuard,
  createArcSwapSuccessPopupActions,
  dismissArcSwapSuccess,
  getArcSwapCompletionTransition,
  isArcSwapSuccessDismissed,
  persistArcSwapSuccessDismissal,
  persistArcSwapSuccessSummary,
  readArcSwapSuccess,
  resolveArcSwapWalletRejection,
  shouldHandleArcSwapCompletion,
  type ArcSwapSuccessSummary,
} from './successLifecycle';

const transactionHash = `0x${'a'.repeat(64)}` as const;
const secondTransactionHash = `0x${'b'.repeat(64)}` as const;
const walletAddress = '0x1111111111111111111111111111111111111111';
const summary: ArcSwapSuccessSummary = {
  amountSold: '1',
  inputToken: { symbol: 'USDC', color: '#2775CA' },
  amountReceived: '0.89',
  actualReceivedVerified: true,
  outputToken: { symbol: 'EURC', color: '#6B8AFD' },
  completedAt: 1_800_000_000_000,
  usdcBalanceBefore: '228.570608',
  usdcBalanceAfter: '240.702397',
  netUsdcBalanceChange: '12.131789',
};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }),
  };
}

describe('Arc Swap persisted success acknowledgement', () => {
  it('survives remount while retaining the confirmed hash and summary separately from recovery history', () => {
    const localStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage });
    const recoveryKey = `orbit:transaction-recovery:v1:${walletAddress}:swap`;
    const recoveryRecord = JSON.stringify({
      status: 'confirmed',
      action: 'swap',
      walletAddress,
      transactions: [{ chainId: 5042002, hash: transactionHash, step: 'swap-1' }],
    });
    localStorage.setItem(recoveryKey, recoveryRecord);

    expect(persistArcSwapSuccessSummary(walletAddress, transactionHash, summary)).toBeNull();
    expect(persistArcSwapSuccessDismissal(walletAddress, transactionHash, summary, 42)).toBeNull();

    const remounted = readArcSwapSuccess(walletAddress, transactionHash);
    expect(remounted).toEqual({
      record: {
        walletAddress,
        transactionHash,
        dismissedAt: 42,
        summary,
      },
      error: null,
    });
    expect(localStorage.getItem(recoveryKey)).toBe(recoveryRecord);
  });

  it('does not clear an existing dismissal when persisting a summary again', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    expect(persistArcSwapSuccessDismissal(walletAddress, transactionHash, summary, 42)).toBeNull();
    expect(persistArcSwapSuccessSummary(walletAddress, transactionHash, summary)).toBeNull();
    expect(readArcSwapSuccess(walletAddress, transactionHash).record?.dismissedAt).toBe(42);
  });

  it('can persist dismissal for a confirmed recovery even when no summary was saved', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    const resetExecution = vi.fn();
    expect(dismissArcSwapSuccess({
      persistDismissal: () => persistArcSwapSuccessDismissal(walletAddress, transactionHash, undefined, 0),
      resetExecution,
      setAmount: vi.fn(),
      setShowReview: vi.fn(),
      setValidationError: vi.fn(),
      clearQuoteSnapshot: vi.fn(),
      clearCompletedAt: vi.fn(),
      invalidateQuote: vi.fn(),
    })).toBeNull();
    expect(resetExecution).toHaveBeenCalledOnce();

    const restored = readArcSwapSuccess(walletAddress, transactionHash);
    expect(restored.error).toBeNull();
    expect(restored.record?.summary).toBeUndefined();
    expect(isArcSwapSuccessDismissed(restored.record)).toBe(true);
    expect(getArcSwapCompletionTransition('confirmed', transactionHash, isArcSwapSuccessDismissed(restored.record))).toBeNull();
  });

  it('scopes dismissal acknowledgements to both wallet and transaction hash', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    expect(persistArcSwapSuccessDismissal(walletAddress, transactionHash, summary, 42)).toBeNull();

    expect(isArcSwapSuccessDismissed(readArcSwapSuccess(walletAddress, transactionHash).record)).toBe(true);
    expect(isArcSwapSuccessDismissed(readArcSwapSuccess(walletAddress, secondTransactionHash).record)).toBe(false);
    expect(isArcSwapSuccessDismissed(readArcSwapSuccess('0x2222222222222222222222222222222222222222', transactionHash).record)).toBe(false);
  });

  it('does not present a legacy quote estimate as actual received output', () => {
    const localStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage });
    localStorage.setItem(
      `orbit:arc-swap-success:v1:${walletAddress}:${transactionHash}`,
      JSON.stringify({
        walletAddress,
        transactionHash,
        dismissedAt: null,
        summary: {
          amountSold: '1',
          inputToken: { symbol: 'EURC', color: '#6B8AFD' },
          amountReceived: '1.214421',
          outputToken: { symbol: 'USDC', color: '#2775CA' },
          completedAt: 1_800_000_000_000,
        },
      }),
    );

    const restored = readArcSwapSuccess(walletAddress, transactionHash);

    expect(restored.error).toBeNull();
    expect(restored.record?.summary?.amountReceived).toBeNull();
    expect(restored.record?.summary?.actualReceivedVerified).toBe(false);
  });

  it('does not retain legacy net-balance figures that were computed by subtracting gas from output', () => {
    const localStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage });
    localStorage.setItem(
      `orbit:arc-swap-success:v1:${walletAddress}:${transactionHash}`,
      JSON.stringify({
        walletAddress,
        transactionHash,
        dismissedAt: null,
        summary: {
          ...summary,
          usdcBalanceBefore: undefined,
          usdcBalanceAfter: undefined,
          netUsdcBalanceChange: '1.204830729',
        },
      }),
    );

    const restored = readArcSwapSuccess(walletAddress, transactionHash);

    expect(restored.record?.summary?.netUsdcBalanceChange).toBeNull();
    expect(restored.record?.summary?.usdcBalanceBefore).toBeNull();
    expect(restored.record?.summary?.usdcBalanceAfter).toBeNull();
  });
});

describe('Arc Swap success lifecycle', () => {
  it('shows success for a confirmed transaction without requiring a current quote and retains its explorer link', () => {
    expect(getArcSwapCompletionTransition('pending', transactionHash)).toBeNull();
    expect(getArcSwapCompletionTransition('confirmed')).toBeNull();
    expect(getArcSwapCompletionTransition('confirmed', transactionHash)).toEqual({
      returnToForm: true,
      transactionHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${transactionHash}`,
    });
  });

  it('does not reopen a confirmed success popup after its dismissal is restored', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    expect(persistArcSwapSuccessDismissal(walletAddress, transactionHash, summary, 42)).toBeNull();
    const restored = readArcSwapSuccess(walletAddress, transactionHash).record;

    expect(restored?.dismissedAt).toBe(42);
    expect(getArcSwapCompletionTransition('confirmed', transactionHash, isArcSwapSuccessDismissed(restored))).toBeNull();
  });

  it('keeps a dismissed popup closed when delayed recovery hydration restores the confirmed hash', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    persistArcSwapSuccessDismissal(walletAddress, transactionHash, summary, 42);

    const delayedHydration = {
      state: 'confirmed' as const,
      transactionHash,
    };
    expect(getArcSwapCompletionTransition(
      delayedHydration.state,
      delayedHydration.transactionHash,
      false,
      false,
    )).toBeNull();
    const dismissal = readArcSwapSuccess(walletAddress, delayedHydration.transactionHash).record;

    expect(getArcSwapCompletionTransition(
      delayedHydration.state,
      delayedHydration.transactionHash,
      isArcSwapSuccessDismissed(dismissal),
    )).toBeNull();
  });

  it.each(['onBack', 'onPrimary'] as const)('%s dismisses the popup and returns to a fresh form', (actionName) => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    const recoveryKey = `orbit:transaction-recovery:v1:${walletAddress}:swap`;
    const recoveryRecord = JSON.stringify({
      status: 'confirmed',
      action: 'swap',
      walletAddress,
      transactions: [{ chainId: 5042002, hash: transactionHash, step: 'swap-1' }],
    });
    window.localStorage.setItem(recoveryKey, recoveryRecord);
    let popupOpen = true;
    let executionState: 'confirmed' | 'idle' = 'confirmed';
    let localHash: typeof transactionHash | undefined = transactionHash;
    let amount = '1';
    let quote: object | undefined = { estimate: 'old quote' };
    const onDismiss = () => {
      dismissArcSwapSuccess({
        persistDismissal: () => persistArcSwapSuccessDismissal(walletAddress, transactionHash, summary),
        resetExecution: () => { executionState = 'idle'; localHash = undefined; },
        setAmount: (nextAmount) => { amount = nextAmount; },
        setShowReview: () => {},
        setValidationError: () => {},
        clearQuoteSnapshot: () => { quote = undefined; },
        clearCompletedAt: () => {},
        invalidateQuote: () => {},
      });
      popupOpen = false;
    };
    const actions = createArcSwapSuccessPopupActions(onDismiss);

    actions[actionName]();

    expect(popupOpen).toBe(false);
    expect({ executionState, localHash, amount, quote }).toEqual({
      executionState: 'idle',
      localHash: undefined,
      amount: '',
      quote: undefined,
    });
    expect(window.localStorage.getItem(recoveryKey)).toBe(recoveryRecord);
    expect(readArcSwapSuccess(walletAddress, transactionHash).record?.dismissedAt).not.toBeNull();
  });

  it('still shows a new transaction success popup after dismissing the previous transaction', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    expect(persistArcSwapSuccessDismissal(walletAddress, transactionHash, summary, 42)).toBeNull();

    expect(getArcSwapCompletionTransition('confirmed', secondTransactionHash, isArcSwapSuccessDismissed(
      readArcSwapSuccess(walletAddress, secondTransactionHash).record,
    ))).toEqual({
      returnToForm: true,
      transactionHash: secondTransactionHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${secondTransactionHash}`,
    });
  });

  it('handles a confirmed transaction once so stale renders cannot repeat the success transition', () => {
    expect(shouldHandleArcSwapCompletion(transactionHash)).toBe(true);
    expect(shouldHandleArcSwapCompletion(transactionHash, transactionHash)).toBe(false);
  });

  it('does not allow a second submission while one is pending or already in flight', () => {
    expect(canSubmitArcSwap('pending', false)).toBe(false);
    expect(canSubmitArcSwap('executing', false)).toBe(false);
    expect(canSubmitArcSwap('confirming', false)).toBe(false);
    expect(canSubmitArcSwap('idle', true)).toBe(false);
    expect(canSubmitArcSwap('confirmed', false)).toBe(true);
    expect(canSubmitArcSwap('reverted', false)).toBe(true);
  });

  it('ignores a delayed result from the prior swap after a new swap starts', () => {
    const runs = createArcSwapRunGuard();
    const firstSwap = runs.start();
    runs.invalidate();
    const secondSwap = runs.start();

    expect(runs.isCurrent(firstSwap)).toBe(false);
    expect(runs.isCurrent(secondSwap)).toBe(true);
  });

  it('keeps consecutive swaps on distinct current execution runs', () => {
    const runs = createArcSwapRunGuard();
    const swaps = [runs.start(), runs.start(), runs.start()];

    expect(swaps.map((run) => runs.isCurrent(run))).toEqual([false, false, true]);
  });

  it('clears execution hash, amount, review, and validation state when success is dismissed', () => {
    const persistDismissal = vi.fn(() => null);
    const resetExecution = vi.fn();
    const setAmount = vi.fn();
    const setShowReview = vi.fn();
    const setValidationError = vi.fn();
    const clearQuoteSnapshot = vi.fn();
    const clearCompletedAt = vi.fn();
    const invalidateQuote = vi.fn();

    expect(dismissArcSwapSuccess({
      persistDismissal,
      resetExecution,
      setAmount,
      setShowReview,
      setValidationError,
      clearQuoteSnapshot,
      clearCompletedAt,
      invalidateQuote,
    })).toBeNull();

    expect(persistDismissal).toHaveBeenCalledOnce();
    expect(resetExecution).toHaveBeenCalledOnce();
    expect(setAmount).toHaveBeenCalledWith('');
    expect(setShowReview).toHaveBeenCalledWith(false);
    expect(setValidationError).toHaveBeenCalledWith(null);
    expect(clearQuoteSnapshot).toHaveBeenCalledOnce();
    expect(clearCompletedAt).toHaveBeenCalledOnce();
    expect(invalidateQuote).toHaveBeenCalledOnce();
  });

  it('starts the next swap from clean local execution and quote state after popup dismissal', () => {
    let state: 'confirmed' | 'idle' = 'confirmed';
    let hash: typeof transactionHash | undefined = transactionHash;
    let amount = '10';
    let quote: object | undefined = { estimatedOutput: { amount: '9.5' } };
    const runs = createArcSwapRunGuard();
    const previousRun = runs.start();

    dismissArcSwapSuccess({
      persistDismissal: () => null,
      resetExecution: () => { runs.invalidate(); state = 'idle'; hash = undefined; },
      setAmount: (nextAmount) => { amount = nextAmount; },
      setShowReview: vi.fn(),
      setValidationError: vi.fn(),
      clearQuoteSnapshot: () => { quote = undefined; },
      clearCompletedAt: vi.fn(),
      invalidateQuote: vi.fn(),
    });

    expect(getArcSwapCompletionTransition(state, hash)).toBeNull();
    expect({ state, hash, amount, quote }).toEqual({ state: 'idle', hash: undefined, amount: '', quote: undefined });
    expect(canSubmitArcSwap(state, false)).toBe(true);
    const nextRun = runs.start();
    expect(runs.isCurrent(previousRun)).toBe(false);
    expect(runs.isCurrent(nextRun)).toBe(true);
  });

  it('does not clear local success state when dismissal persistence fails', () => {
    const resetExecution = vi.fn();
    const result = dismissArcSwapSuccess({
      persistDismissal: () => new Error('storage unavailable'),
      resetExecution,
      setAmount: vi.fn(),
      setShowReview: vi.fn(),
      setValidationError: vi.fn(),
      clearQuoteSnapshot: vi.fn(),
      clearCompletedAt: vi.fn(),
      invalidateQuote: vi.fn(),
    });

    expect(result?.message).toBe('storage unavailable');
    expect(resetExecution).not.toHaveBeenCalled();
  });

  it('clears recovery only for an explicit rejection before any hash', async () => {
    const resolveHashlessRequest = vi.fn(async () => null);
    await expect(resolveArcSwapWalletRejection(
      { code: 4001 },
      undefined,
      resolveHashlessRequest,
    )).resolves.toEqual({ handled: true });
    expect(resolveHashlessRequest).toHaveBeenCalledOnce();
  });

  it('retains the recovery lock for ambiguous errors and any observed hash', async () => {
    const resolveHashlessRequest = vi.fn(async () => null);
    await expect(resolveArcSwapWalletRejection(
      new Error('Wallet request failed'),
      undefined,
      resolveHashlessRequest,
    )).resolves.toEqual({ handled: false });
    await expect(resolveArcSwapWalletRejection(
      { code: 4001 },
      transactionHash,
      resolveHashlessRequest,
    )).resolves.toEqual({ handled: false });
    expect(resolveHashlessRequest).not.toHaveBeenCalled();
  });

  it('keeps an explicit rejection uncertain if safe recovery cleanup fails', async () => {
    const cleanupError = new Error('Recovery record changed');
    await expect(resolveArcSwapWalletRejection(
      { cause: { code: '4001' } },
      undefined,
      async () => cleanupError,
    )).resolves.toEqual({ handled: true, recoveryError: cleanupError });
  });
});
