import type { Hash } from 'viem';

export interface ArcSwapReceiptAccountingIdentity {
  walletAddress: string;
  transactionHash: Hash;
}

export interface ArcSwapReceiptAccountingGenerationIdentity extends ArcSwapReceiptAccountingIdentity {
  generation: number;
}

export interface ArcSwapReceiptAccountingResult<T> extends ArcSwapReceiptAccountingGenerationIdentity {
  accounting: T;
}

export interface ArcSwapReceiptAccountingRequestCallbacks<T> {
  onStart: (identity: ArcSwapReceiptAccountingIdentity) => void;
  onSuccess: (result: ArcSwapReceiptAccountingResult<T>) => void;
  onError: (error: unknown, identity: ArcSwapReceiptAccountingIdentity) => void;
  onFinish: (identity: ArcSwapReceiptAccountingIdentity) => void;
  onAcknowledged?: (result: ArcSwapReceiptAccountingResult<T>) => void;
}

export interface ArcSwapReceiptAccountingLifecycleActions<T> {
  getGeneration: (identity: ArcSwapReceiptAccountingIdentity) => number | null;
  setRequestIdentity: (identity: ArcSwapReceiptAccountingIdentity) => void;
  setRequestGeneration: (generation: number | null) => void;
  setLoading: (loading: boolean) => void;
  clearResult: () => void;
  clearError: () => void;
  clearVerifiedStatus: () => void;
  setResult: (result: ArcSwapReceiptAccountingResult<T>) => void;
  setError: (message: string) => void;
}

export function createArcSwapReceiptAccountingLifecycleCallbacks<T>(
  actions: ArcSwapReceiptAccountingLifecycleActions<T>,
): Pick<ArcSwapReceiptAccountingRequestCallbacks<T>, 'onStart' | 'onSuccess' | 'onError' | 'onFinish'> {
  return {
    onStart: (identity) => {
      actions.setRequestIdentity(identity);
      actions.setRequestGeneration(actions.getGeneration(identity));
      actions.setLoading(true);
      actions.clearResult();
      actions.clearError();
      actions.clearVerifiedStatus();
    },
    onSuccess: actions.setResult,
    onError: (error) => actions.setError(error instanceof Error
      ? error.message
      : 'Actual swap amounts could not be verified from the Arc Testnet receipt.'),
    onFinish: () => actions.setLoading(false),
  };
}

export type ArcSwapReceiptAccountingState = 'idle' | 'pending' | 'executing' | 'confirming' | 'confirmed' | 'failed' | 'timeout' | 'rpc-error' | 'uncertain' | 'reverted';

interface QueuedRequest<T> {
  identity: ArcSwapReceiptAccountingIdentity;
  load: () => Promise<T>;
  callbacks: ArcSwapReceiptAccountingRequestCallbacks<T>;
  generation: number;
}

interface InFlightRequest<T> {
  generation: number;
  queued?: QueuedRequest<T>;
}

function requestKey(identity: ArcSwapReceiptAccountingIdentity): string {
  return `${identity.walletAddress.toLowerCase()}:${identity.transactionHash.toLowerCase()}`;
}

export function isArcSwapReceiptAccountingCurrent(
  identity: ArcSwapReceiptAccountingGenerationIdentity | null | undefined,
  walletAddress: string | undefined,
  transactionHash: string | undefined,
  currentGeneration: number | null,
): boolean {
  return Boolean(
    identity &&
    walletAddress &&
    transactionHash &&
    currentGeneration !== null &&
    identity.walletAddress.toLowerCase() === walletAddress.toLowerCase() &&
    identity.transactionHash.toLowerCase() === transactionHash.toLowerCase() &&
    identity.generation === currentGeneration,
  );
}

export function runArcSwapReceiptAccountingIfCurrent<T>(
  identity: ArcSwapReceiptAccountingGenerationIdentity | null | undefined,
  walletAddress: string | undefined,
  transactionHash: string | undefined,
  currentGeneration: number | null,
  effect: () => T,
): T | undefined {
  if (!isArcSwapReceiptAccountingCurrent(identity, walletAddress, transactionHash, currentGeneration)) return undefined;
  return effect();
}

export class ArcSwapReceiptAccountingRequestManager<T> {
  private currentKey: string | null = null;
  private generation = 0;
  private mounted = true;
  private readonly inFlight = new Map<string, InFlightRequest<T>>();
  private readonly acknowledged = new Set<string>();

  setContext(identity: ArcSwapReceiptAccountingIdentity | null): void {
    const nextKey = identity ? requestKey(identity) : null;
    if (nextKey !== this.currentKey) {
      this.currentKey = nextKey;
      this.generation += 1;
    }
  }

  activate(): void {
    this.mounted = true;
    this.generation += 1;
  }

  dispose(): void {
    this.mounted = false;
    this.currentKey = null;
    this.generation += 1;
    for (const request of this.inFlight.values()) request.queued = undefined;
  }

  isCurrent(identity: ArcSwapReceiptAccountingIdentity): boolean {
    return this.mounted && this.currentKey === requestKey(identity);
  }

  getCurrentGeneration(identity: ArcSwapReceiptAccountingIdentity): number | null {
    return this.isCurrent(identity) ? this.generation : null;
  }

  isCurrentGeneration(identity: ArcSwapReceiptAccountingIdentity, generation: number): boolean {
    return this.isCurrent(identity) && generation === this.generation;
  }

  async run(
    identity: ArcSwapReceiptAccountingIdentity,
    load: () => Promise<T>,
    callbacks: ArcSwapReceiptAccountingRequestCallbacks<T>,
  ): Promise<boolean> {
    if (!this.isCurrent(identity)) return false;

    const key = requestKey(identity);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.generation !== this.generation) {
        existing.queued = { identity, load, callbacks, generation: this.generation };
      }
      return false;
    }

    const request: InFlightRequest<T> = { generation: this.generation };
    this.inFlight.set(key, request);
    let succeeded = false;
    try {
      callbacks.onStart(identity);
      const accounting = await load();
      if (this.canApply(request, identity)) {
        const result = { ...identity, generation: request.generation, accounting };
        callbacks.onSuccess(result);
        if (!this.acknowledged.has(key)) {
          this.acknowledged.add(key);
          callbacks.onAcknowledged?.(result);
        }
        succeeded = true;
      }
    } catch (error) {
      if (this.canApply(request, identity)) callbacks.onError(error, identity);
    } finally {
      try {
        if (this.canApply(request, identity)) callbacks.onFinish(identity);
      } finally {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
        const queued = request.queued;
        if (queued && this.isCurrent(queued.identity) && queued.generation === this.generation) {
          void this.run(queued.identity, queued.load, queued.callbacks);
        }
      }
    }
    return succeeded;
  }

  private canApply(
    request: InFlightRequest<T>,
    identity: ArcSwapReceiptAccountingIdentity,
  ): boolean {
    return this.mounted &&
      request.generation === this.generation &&
      this.currentKey === requestKey(identity);
  }
}

export function retryArcSwapReceiptAccounting<T>(
  state: ArcSwapReceiptAccountingState,
  manager: ArcSwapReceiptAccountingRequestManager<T>,
  identity: ArcSwapReceiptAccountingIdentity | null,
  load: () => Promise<T>,
  callbacks: ArcSwapReceiptAccountingRequestCallbacks<T>,
): Promise<boolean> {
  if (state !== 'confirmed' || !identity) return Promise.resolve(false);
  return manager.run(identity, load, callbacks);
}
