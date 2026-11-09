import type { Hash } from 'viem';
import type { BridgeStatus } from '../../types/bridge';

export type CctpLifecycleStatus =
  | 'preparing'
  | 'source-pending'
  | 'source-confirmed'
  | 'attestation-pending'
  | 'attestation-ready';

export interface CctpLifecycleSnapshot {
  status: CctpLifecycleStatus;
  sourceHash?: Hash;
  bridgeStatus?: BridgeStatus;
}

export interface CctpLifecycleAdapter {
  submitSource(): Promise<Hash>;
  waitForSource(hash: Hash): Promise<void>;
  pollAttestation(hash: Hash): Promise<BridgeStatus>;
  waitBeforeNextPoll(): Promise<void>;
}

export function createBridgeExecutionGate() {
  let active = false;
  let sourceSubmitted = false;

  return {
    begin() {
      if (active || sourceSubmitted) return false;
      active = true;
      return true;
    },
    markSourceSubmitted() {
      sourceSubmitted = true;
    },
    releaseWalletRejection() {
      sourceSubmitted = false;
    },
    finish() {
      active = false;
    },
    reset() {
      if (active) return false;
      sourceSubmitted = false;
      return true;
    },
    isActive() {
      return active;
    },
    hasSubmittedSource() {
      return sourceSubmitted;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Circle status request timed out.')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function pollCctpAttestation(
  sourceHash: Hash,
  adapter: Pick<CctpLifecycleAdapter, 'pollAttestation' | 'waitBeforeNextPoll'>,
  onUpdate: (snapshot: CctpLifecycleSnapshot) => void,
  maxPolls = 20,
  pollTimeoutMs = 15_000,
): Promise<BridgeStatus> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    onUpdate({ status: 'attestation-pending', sourceHash });
    let status: BridgeStatus | undefined;
    try {
      status = await withTimeout(adapter.pollAttestation(sourceHash), pollTimeoutMs);
      lastError = undefined;
      onUpdate({
        status: status.status === 'DONE' ? 'attestation-ready' : 'attestation-pending',
        sourceHash,
        bridgeStatus: status,
      });
    } catch (caughtError) {
      lastError = caughtError instanceof Error ? caughtError : new Error('Circle status could not be checked.');
    }
    if (status?.status === 'FAILED') {
      throw new Error(status.substatus ?? 'Circle could not process this transfer.');
    }
    if (status?.status === 'DONE' && status.message && status.attestation) return status;
    if (attempt < maxPolls - 1) await adapter.waitBeforeNextPoll();
  }

  throw new Error(
    lastError
      ? `Circle status could not be verified after ${maxPolls} checks. The source transaction will not be resubmitted. Last error: ${lastError.message}`
      : `Circle attestation is still pending after ${maxPolls} checks. The source transaction will not be resubmitted.`,
  );
}

export async function resumeCctpBridgeLifecycle(
  sourceHash: Hash,
  adapter: Pick<CctpLifecycleAdapter, 'pollAttestation' | 'waitBeforeNextPoll'>,
  onUpdate: (snapshot: CctpLifecycleSnapshot) => void,
  maxPolls = 20,
  pollTimeoutMs = 15_000,
): Promise<BridgeStatus> {
  return pollCctpAttestation(sourceHash, adapter, onUpdate, maxPolls, pollTimeoutMs);
}

export async function runCctpBridgeLifecycle(
  adapter: CctpLifecycleAdapter,
  onUpdate: (snapshot: CctpLifecycleSnapshot) => void,
  maxPolls = 20,
  pollTimeoutMs = 15_000,
): Promise<{ sourceHash: Hash; status: BridgeStatus }> {
  onUpdate({ status: 'preparing' });
  const sourceHash = await adapter.submitSource();
  onUpdate({ status: 'source-pending', sourceHash });
  await adapter.waitForSource(sourceHash);
  onUpdate({ status: 'source-confirmed', sourceHash });
  const status = await pollCctpAttestation(sourceHash, adapter, onUpdate, maxPolls, pollTimeoutMs);
  return { sourceHash, status };
}
