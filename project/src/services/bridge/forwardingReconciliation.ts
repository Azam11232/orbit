import type { Hash } from 'viem';

export interface ForwardingStatusSnapshot {
  forwardState?: string | null;
  forwardTxHash?: string | null;
  forwardErrorDetails?: string | null;
}

export interface ForwardingReconciliationAdapter {
  verifySourceReceipt(sourceHash: Hash): Promise<boolean>;
  pollStatus(sourceHash: Hash): Promise<ForwardingStatusSnapshot | undefined>;
  verifyDestinationReceipt(destinationHash: Hash): Promise<boolean | 'failed'>;
  waitBeforeNextPoll(): Promise<void>;
}

export interface ForwardingReconciliationOptions {
  pollingWindowMs?: number;
  destinationHashHint?: Hash;
  now?: () => number;
  onDestinationHash?: (hash: Hash) => void;
}

const DEFAULT_POLLING_WINDOW_MS = 5 * 60_000;

export class BridgeTrackingTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeTrackingTimeoutError';
  }
}

function isHash(value: string | null | undefined): value is Hash {
  return typeof value === 'string' && /^0x[a-f\d]{64}$/i.test(value);
}

export async function reconcileForwardingTransfer(
  sourceHash: Hash,
  adapter: ForwardingReconciliationAdapter,
  options: ForwardingReconciliationOptions = {},
): Promise<{ sourceHash: Hash; destinationHash: Hash }> {
  if (!await adapter.verifySourceReceipt(sourceHash)) {
    throw new Error('The source transaction receipt did not confirm successfully.');
  }

  const now = options.now ?? Date.now;
  const deadline = now() + (options.pollingWindowMs ?? DEFAULT_POLLING_WINDOW_MS);
  let lastLookupError: Error | undefined;
  if (options.destinationHashHint) {
    options.onDestinationHash?.(options.destinationHashHint);
    let receiptVerification: boolean | 'failed' | undefined;
    try {
      receiptVerification = await adapter.verifyDestinationReceipt(options.destinationHashHint);
    } catch (caughtError) {
      lastLookupError = caughtError instanceof Error
        ? caughtError
        : new Error('Destination receipt verification could not be completed.');
    }
    if (receiptVerification === 'failed') throw new Error('The destination transaction receipt reverted.');
    if (receiptVerification) return { sourceHash, destinationHash: options.destinationHashHint };
  }

  let checks = 0;
  while (now() < deadline) {
    checks += 1;
    let status: ForwardingStatusSnapshot | undefined;
    try {
      status = await adapter.pollStatus(sourceHash);
      if (status) lastLookupError = undefined;
    } catch (caughtError) {
      lastLookupError = caughtError instanceof Error
        ? caughtError
        : new Error('Circle forwarding status could not be checked.');
    }

    const forwardState = status?.forwardState?.toUpperCase();
    const destinationHash = status?.forwardTxHash;
    if (isHash(destinationHash)) {
      options.onDestinationHash?.(destinationHash);
      let receiptVerification: boolean | 'failed' | undefined;
      try {
        receiptVerification = await adapter.verifyDestinationReceipt(destinationHash);
      } catch (caughtError) {
        lastLookupError = caughtError instanceof Error
          ? caughtError
          : new Error('Destination receipt verification could not be completed.');
      }
      if (receiptVerification === 'failed') {
        throw new Error('The destination transaction receipt reverted.');
      }
      if (receiptVerification) return { sourceHash, destinationHash };
    }

    if (forwardState === 'FAILED') {
      throw new Error(status?.forwardErrorDetails ?? 'Circle confirmed that destination forwarding failed.');
    }

    if (now() < deadline) await adapter.waitBeforeNextPoll();
  }

  throw new BridgeTrackingTimeoutError(
    lastLookupError
      ? `Still processing. Status could not be verified during the last polling window (${checks} checks). Last check: ${lastLookupError.message}`
      : `Still processing. Destination completion could not be verified during the last polling window (${checks} checks).`,
  );
}
