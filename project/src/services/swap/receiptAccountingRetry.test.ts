import { describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import { getArcSwapCompletionTransition } from './successLifecycle';
import {
  ArcSwapReceiptAccountingRequestManager,
  createArcSwapReceiptAccountingLifecycleCallbacks,
  runArcSwapReceiptAccountingIfCurrent,
  retryArcSwapReceiptAccounting,
  type ArcSwapReceiptAccountingIdentity,
  type ArcSwapReceiptAccountingRequestCallbacks,
} from './receiptAccountingRetry';

const walletA: ArcSwapReceiptAccountingIdentity = {
  walletAddress: '0x1111111111111111111111111111111111111111',
  transactionHash: `0x${'a'.repeat(64)}` as Hash,
};
const walletB: ArcSwapReceiptAccountingIdentity = {
  walletAddress: '0x2222222222222222222222222222222222222222',
  transactionHash: `0x${'b'.repeat(64)}` as Hash,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function callbacks<T>(overrides: Partial<ArcSwapReceiptAccountingRequestCallbacks<T>> = {}) {
  return {
    onStart: vi.fn(overrides.onStart ?? (() => undefined)),
    onSuccess: vi.fn(overrides.onSuccess ?? (() => undefined)),
    onError: vi.fn(overrides.onError ?? (() => undefined)),
    onFinish: vi.fn(overrides.onFinish ?? (() => undefined)),
    onAcknowledged: vi.fn(overrides.onAcknowledged ?? (() => undefined)),
  };
}

describe('Arc Swap receipt accounting retry integration', () => {
  it('keeps loading active until the in-flight receipt request finishes', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const receipt = deferred<string>();
    const state = {
      loading: false,
      requestIdentity: null as ArcSwapReceiptAccountingIdentity | null,
      requestGeneration: null as number | null,
      result: null as string | null,
      error: null as string | null,
      statusVerified: false,
    };
    const lifecycle = createArcSwapReceiptAccountingLifecycleCallbacks<string>({
      getGeneration: (identity) => manager.getCurrentGeneration(identity),
      setRequestIdentity: (identity) => { state.requestIdentity = identity; },
      setRequestGeneration: (generation) => { state.requestGeneration = generation; },
      setLoading: (loading) => { state.loading = loading; },
      clearResult: () => { state.result = null; },
      clearError: () => { state.error = null; },
      clearVerifiedStatus: () => { state.statusVerified = false; },
      setResult: ({ accounting }) => { state.result = accounting; },
      setError: (message) => { state.error = message; },
    });

    const pending = retryArcSwapReceiptAccounting(
      'confirmed',
      manager,
      walletA,
      () => receipt.promise,
      lifecycle,
    );
    expect(state.loading).toBe(true);
    expect(state.requestIdentity).toEqual(walletA);
    expect(state.requestGeneration).not.toBeNull();

    receipt.resolve('verified receipt');
    await expect(pending).resolves.toBe(true);
    expect(state.loading).toBe(false);
    expect(state.result).toBe('verified receipt');
  });

  it('keeps the failed retry error visible after loading finishes', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const receipt = deferred<string>();
    const state = {
      loading: false,
      requestIdentity: null as ArcSwapReceiptAccountingIdentity | null,
      requestGeneration: null as number | null,
      result: null as string | null,
      error: null as string | null,
      statusVerified: false,
    };
    const lifecycle = createArcSwapReceiptAccountingLifecycleCallbacks<string>({
      getGeneration: (identity) => manager.getCurrentGeneration(identity),
      setRequestIdentity: (identity) => { state.requestIdentity = identity; },
      setRequestGeneration: (generation) => { state.requestGeneration = generation; },
      setLoading: (loading) => { state.loading = loading; },
      clearResult: () => { state.result = null; },
      clearError: () => { state.error = null; },
      clearVerifiedStatus: () => { state.statusVerified = false; },
      setResult: ({ accounting }) => { state.result = accounting; },
      setError: (message) => { state.error = message; },
    });

    const pending = retryArcSwapReceiptAccounting(
      'confirmed',
      manager,
      walletA,
      () => receipt.promise,
      lifecycle,
    );
    expect(state.loading).toBe(true);
    receipt.reject(new Error('Receipt RPC unavailable'));
    await expect(pending).resolves.toBe(false);

    expect(state.loading).toBe(false);
    expect(state.error).toBe('Receipt RPC unavailable');
    expect(state.requestIdentity).toEqual(walletA);
    expect(state.requestGeneration).not.toBeNull();
  });

  it('retries the same confirmed hash after an accounting failure and exposes loading and error transitions', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const events: string[] = [];
    const requestCallbacks = callbacks<string>({
      onStart: () => events.push('loading'),
      onError: (error) => events.push(`error:${(error as Error).message}`),
      onSuccess: () => events.push('success'),
      onFinish: () => events.push('finished'),
    });
    const loadReceiptAccounting = vi.fn()
      .mockRejectedValueOnce(new Error('Receipt RPC unavailable'))
      .mockResolvedValueOnce('verified actual amount');

    await expect(retryArcSwapReceiptAccounting(
      'confirmed',
      manager,
      walletA,
      loadReceiptAccounting,
      requestCallbacks,
    )).resolves.toBe(false);
    await expect(retryArcSwapReceiptAccounting(
      'confirmed',
      manager,
      walletA,
      loadReceiptAccounting,
      requestCallbacks,
    )).resolves.toBe(true);

    expect(loadReceiptAccounting).toHaveBeenCalledTimes(2);
    expect(requestCallbacks.onStart).toHaveBeenCalledTimes(2);
    expect(requestCallbacks.onFinish).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      'loading',
      'error:Receipt RPC unavailable',
      'finished',
      'loading',
      'success',
      'finished',
    ]);
  });

  it('does not retry until confirmed and only invokes the receipt reader with the original hash', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const generation = manager.getCurrentGeneration(walletA);
    const readTransaction = vi.fn().mockResolvedValue('transaction');
    const readReceipt = vi.fn().mockResolvedValue('receipt');
    const accountExistingReceipt = vi.fn(async (hash: Hash) => {
      await Promise.all([readTransaction(hash), readReceipt(hash)]);
      return 'verified amount';
    });
    const requestCallbacks = callbacks<string>();

    await expect(retryArcSwapReceiptAccounting(
      'pending',
      manager,
      walletA,
      () => accountExistingReceipt(walletA.transactionHash),
      requestCallbacks,
    )).resolves.toBe(false);
    expect(accountExistingReceipt).not.toHaveBeenCalled();

    await expect(retryArcSwapReceiptAccounting(
      'confirmed',
      manager,
      walletA,
      () => accountExistingReceipt(walletA.transactionHash),
      requestCallbacks,
    )).resolves.toBe(true);

    expect(readTransaction).toHaveBeenCalledTimes(1);
    expect(readTransaction).toHaveBeenCalledWith(walletA.transactionHash);
    expect(readReceipt).toHaveBeenCalledTimes(1);
    expect(readReceipt).toHaveBeenCalledWith(walletA.transactionHash);
    expect(requestCallbacks.onSuccess).toHaveBeenCalledWith({
      ...walletA,
      generation,
      accounting: 'verified amount',
    });
  });

  it('deduplicates repeated clicks for the same active wallet and hash', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const receipt = deferred<string>();
    const loadReceipt = vi.fn(() => receipt.promise);
    const requestCallbacks = callbacks<string>();

    const first = retryArcSwapReceiptAccounting('confirmed', manager, walletA, loadReceipt, requestCallbacks);
    await expect(retryArcSwapReceiptAccounting('confirmed', manager, walletA, loadReceipt, requestCallbacks))
      .resolves.toBe(false);
    expect(loadReceipt).toHaveBeenCalledTimes(1);

    receipt.resolve('verified receipt');
    await expect(first).resolves.toBe(true);
    expect(requestCallbacks.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('ignores wallet A results after switching to wallet B', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const requestA = deferred<string>();
    const requestB = deferred<string>();
    const callbacksA = callbacks<string>();
    const callbacksB = callbacks<string>();

    const pendingA = retryArcSwapReceiptAccounting('confirmed', manager, walletA, () => requestA.promise, callbacksA);
    manager.setContext(walletB);
    const pendingB = retryArcSwapReceiptAccounting('confirmed', manager, walletB, () => requestB.promise, callbacksB);
    requestA.resolve('wallet A receipt');
    await expect(pendingA).resolves.toBe(false);
    expect(callbacksA.onSuccess).not.toHaveBeenCalled();
    expect(callbacksA.onAcknowledged).not.toHaveBeenCalled();

    requestB.resolve('wallet B receipt');
    await expect(pendingB).resolves.toBe(true);
    const generationB = manager.getCurrentGeneration(walletB);
    expect(callbacksB.onSuccess).toHaveBeenCalledWith({
      ...walletB,
      generation: generationB,
      accounting: 'wallet B receipt',
    });
    expect(callbacksB.onAcknowledged).toHaveBeenCalledTimes(1);
  });

  it('does not persist or acknowledge accounting for a different current wallet or hash', () => {
    const persistSuccess = vi.fn();
    const result = { ...walletA, generation: 1 };
    const staleWalletResult = runArcSwapReceiptAccountingIfCurrent(
      result,
      walletB.walletAddress,
      walletA.transactionHash,
      1,
      persistSuccess,
    );
    const staleHashResult = runArcSwapReceiptAccountingIfCurrent(
      result,
      walletA.walletAddress,
      walletB.transactionHash,
      1,
      persistSuccess,
    );

    expect(staleWalletResult).toBeUndefined();
    expect(staleHashResult).toBeUndefined();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  it('rejects A to B to A results even when the original wallet and hash return', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const originalGeneration = manager.getCurrentGeneration(walletA)!;
    const receipt = deferred<string>();
    const requestCallbacks = callbacks<string>();
    const pending = retryArcSwapReceiptAccounting(
      'confirmed',
      manager,
      walletA,
      () => receipt.promise,
      requestCallbacks,
    );

    manager.setContext(walletB);
    manager.setContext(walletA);
    const returnedGeneration = manager.getCurrentGeneration(walletA)!;
    receipt.resolve('receipt from original generation');
    await expect(pending).resolves.toBe(false);

    expect(returnedGeneration).not.toBe(originalGeneration);
    expect(requestCallbacks.onSuccess).not.toHaveBeenCalled();
    expect(requestCallbacks.onAcknowledged).not.toHaveBeenCalled();
  });

  it('rejects stale-generation persistence and success completion', () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const staleResult = {
      ...walletA,
      generation: manager.getCurrentGeneration(walletA)!,
    };
    const persistSuccess = vi.fn();
    manager.setContext(walletB);
    manager.setContext(walletA);
    const currentGeneration = manager.getCurrentGeneration(walletA);

    const persisted = runArcSwapReceiptAccountingIfCurrent(
      staleResult,
      walletA.walletAddress,
      walletA.transactionHash,
      currentGeneration,
      persistSuccess,
    );
    const completion = runArcSwapReceiptAccountingIfCurrent(
      staleResult,
      walletA.walletAddress,
      walletA.transactionHash,
      currentGeneration,
      () => getArcSwapCompletionTransition('confirmed', walletA.transactionHash),
    );

    expect(persisted).toBeUndefined();
    expect(persistSuccess).not.toHaveBeenCalled();
    expect(completion).toBeUndefined();
  });

  it('accepts a current-generation result for persistence and success completion', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const requestCallbacks = callbacks<string>();
    await retryArcSwapReceiptAccounting('confirmed', manager, walletA, async () => 'verified amount', requestCallbacks);

    const currentGeneration = manager.getCurrentGeneration(walletA);
    const result = requestCallbacks.onSuccess.mock.calls[0]?.[0];
    expect(result).toBeDefined();
    const persistSuccess = vi.fn(() => 'persisted');
    const persisted = runArcSwapReceiptAccountingIfCurrent(
      result,
      walletA.walletAddress,
      walletA.transactionHash,
      currentGeneration,
      persistSuccess,
    );
    const completion = runArcSwapReceiptAccountingIfCurrent(
      result,
      walletA.walletAddress,
      walletA.transactionHash,
      currentGeneration,
      () => getArcSwapCompletionTransition('confirmed', walletA.transactionHash),
    );

    expect(result?.generation).toBe(currentGeneration);
    expect(persisted).toBe('persisted');
    expect(persistSuccess).toHaveBeenCalledTimes(1);
    expect(completion).toEqual(getArcSwapCompletionTransition('confirmed', walletA.transactionHash));
  });

  it('queues one fresh wallet A request when switching back before the original finishes', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const firstRequest = deferred<string>();
    const secondRequest = deferred<string>();
    const loadReceipt = vi.fn()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const requestCallbacks = callbacks<string>();

    const pendingFirst = retryArcSwapReceiptAccounting('confirmed', manager, walletA, loadReceipt, requestCallbacks);
    manager.setContext(walletB);
    manager.setContext(walletA);
    await expect(retryArcSwapReceiptAccounting('confirmed', manager, walletA, loadReceipt, requestCallbacks))
      .resolves.toBe(false);
    expect(loadReceipt).toHaveBeenCalledTimes(1);

    firstRequest.resolve('stale result');
    await expect(pendingFirst).resolves.toBe(false);
    await vi.waitFor(() => expect(loadReceipt).toHaveBeenCalledTimes(2));
    expect(requestCallbacks.onSuccess).not.toHaveBeenCalled();

    secondRequest.resolve('current result');
    await vi.waitFor(() => expect(requestCallbacks.onSuccess).toHaveBeenCalledTimes(1));
    expect(requestCallbacks.onSuccess).toHaveBeenCalledWith({
      ...walletA,
      generation: manager.getCurrentGeneration(walletA),
      accounting: 'current result',
    });
  });

  it('does not update state or acknowledge after unmount', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const pendingReceipt = deferred<string>();
    const requestCallbacks = callbacks<string>();
    const pending = retryArcSwapReceiptAccounting(
      'confirmed',
      manager,
      walletA,
      () => pendingReceipt.promise,
      requestCallbacks,
    );

    manager.dispose();
    pendingReceipt.resolve('receipt after unmount');
    await expect(pending).resolves.toBe(false);

    expect(requestCallbacks.onSuccess).not.toHaveBeenCalled();
    expect(requestCallbacks.onError).not.toHaveBeenCalled();
    expect(requestCallbacks.onFinish).not.toHaveBeenCalled();
    expect(requestCallbacks.onAcknowledged).not.toHaveBeenCalled();
  });

  it('survives Strict Mode effect cleanup and replay without applying the disposed request', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.activate();
    manager.setContext(walletA);
    const disposedRequest = deferred<string>();
    const replayedRequest = deferred<string>();
    const loadReceipt = vi.fn()
      .mockReturnValueOnce(disposedRequest.promise)
      .mockReturnValueOnce(replayedRequest.promise);
    const requestCallbacks = callbacks<string>();

    const first = retryArcSwapReceiptAccounting('confirmed', manager, walletA, loadReceipt, requestCallbacks);
    manager.dispose();
    manager.activate();
    manager.setContext(walletA);
    const replayed = retryArcSwapReceiptAccounting('confirmed', manager, walletA, loadReceipt, requestCallbacks);
    expect(loadReceipt).toHaveBeenCalledTimes(1);

    disposedRequest.resolve('disposed result');
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(loadReceipt).toHaveBeenCalledTimes(2));
    expect(requestCallbacks.onSuccess).not.toHaveBeenCalled();

    replayedRequest.resolve('replayed result');
    await expect(replayed).resolves.toBe(false);
    await vi.waitFor(() => expect(requestCallbacks.onSuccess).toHaveBeenCalledTimes(1));
    expect(requestCallbacks.onSuccess).toHaveBeenCalledWith({
      ...walletA,
      generation: manager.getCurrentGeneration(walletA),
      accounting: 'replayed result',
    });
  });

  it('acknowledges and refreshes balances only once for a successful address/hash', async () => {
    const manager = new ArcSwapReceiptAccountingRequestManager<string>();
    manager.setContext(walletA);
    const onAcknowledged = vi.fn();
    const requestCallbacks = callbacks<string>({ onAcknowledged });

    await retryArcSwapReceiptAccounting('confirmed', manager, walletA, async () => 'first success', requestCallbacks);
    await retryArcSwapReceiptAccounting('confirmed', manager, walletA, async () => 'later refresh', requestCallbacks);

    expect(requestCallbacks.onSuccess).toHaveBeenCalledTimes(2);
    expect(onAcknowledged).toHaveBeenCalledTimes(1);
    expect(onAcknowledged).toHaveBeenCalledWith({
      ...walletA,
      generation: manager.getCurrentGeneration(walletA),
      accounting: 'first success',
    });
  });
});
