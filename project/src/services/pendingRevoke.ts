import type { Address, Hash } from 'viem';

export interface PendingRevokeRecord {
  walletAddress: Address;
  tokenAddress: Address;
  spenderAddress: Address;
  phase: 'wallet-request' | 'submitted' | 'confirmed';
  hash?: Hash;
  receiptBlock?: bigint;
}

export type RevokeSubmissionAction =
  | { type: 'submit' }
  | { type: 'resume'; record: PendingRevokeRecord }
  | { type: 'blocked'; error: Error };

interface SerializedPendingRevokeRecord {
  version: 2;
  walletAddress: string;
  tokenAddress: string;
  spenderAddress: string;
  phase: PendingRevokeRecord['phase'];
  hash?: string;
  receiptBlock?: string;
}

const STORAGE_KEY_PREFIX = 'orbit:pending-revoke:v1';
const pendingRevokeByWallet = new Map<string, PendingRevokeRecord>();
const activeRevokeWallets = new Set<string>();

function walletKey(walletAddress: Address): string {
  return walletAddress.toLowerCase();
}

function storageKey(walletAddress: Address): string {
  return `${STORAGE_KEY_PREFIX}:${walletKey(walletAddress)}`;
}

function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[a-f\d]{40}$/i.test(value);
}

function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && /^0x[a-f\d]{64}$/i.test(value);
}

function parsePendingRevokeRecord(value: unknown, walletAddress: Address): PendingRevokeRecord {
  const raw = typeof value === 'object' && value !== null ? value : null;
  const receiptBlock = raw && 'receiptBlock' in raw ? raw.receiptBlock : undefined;
  const hash = raw && 'hash' in raw ? raw.hash : undefined;
  const phase = raw && 'phase' in raw ? raw.phase : undefined;
  const version = raw && 'version' in raw ? raw.version : undefined;
  if (
    !raw ||
    (version !== 1 && version !== 2) ||
    !('walletAddress' in raw) ||
    !isAddress(raw.walletAddress) ||
    raw.walletAddress.toLowerCase() !== walletKey(walletAddress) ||
    !('tokenAddress' in raw) ||
    !isAddress(raw.tokenAddress) ||
    !('spenderAddress' in raw) ||
    !isAddress(raw.spenderAddress) ||
    (version === 1 && !isHash(hash)) ||
    (version === 2 && phase !== 'wallet-request' && phase !== 'submitted' && phase !== 'confirmed') ||
    (version === 2 && phase === 'wallet-request' && hash !== undefined) ||
    (version === 2 && phase === 'wallet-request' && receiptBlock !== undefined) ||
    (version === 2 && phase === 'submitted' && receiptBlock !== undefined) ||
    ((phase === 'submitted' || version === 1) && !isHash(hash)) ||
    (phase === 'confirmed' && !isHash(hash)) ||
    (phase === 'confirmed' && receiptBlock === undefined) ||
    (receiptBlock !== undefined &&
      (typeof receiptBlock !== 'string' || !/^\d+$/.test(receiptBlock)))
  ) {
    throw new Error('Saved pending revoke data is invalid; scan approvals before submitting another revoke.');
  }

  return {
    walletAddress: raw.walletAddress,
    tokenAddress: raw.tokenAddress,
    spenderAddress: raw.spenderAddress,
    phase: version === 1
      ? receiptBlock === undefined ? 'submitted' : 'confirmed'
      : phase as PendingRevokeRecord['phase'],
    hash: isHash(hash) ? hash : undefined,
    receiptBlock: typeof receiptBlock === 'string' ? BigInt(receiptBlock) : undefined,
  };
}

export function loadPendingRevoke(walletAddress: Address): { record: PendingRevokeRecord | null; error: Error | null } {
  const key = walletKey(walletAddress);
  const cached = pendingRevokeByWallet.get(key);
  if (cached) return { record: cached, error: null };
  if (typeof window === 'undefined') return { record: null, error: null };

  try {
    const serialized = window.sessionStorage.getItem(storageKey(walletAddress));
    if (serialized === null) return { record: null, error: null };
    const record = parsePendingRevokeRecord(JSON.parse(serialized) as unknown, walletAddress);
    pendingRevokeByWallet.set(key, record);
    return { record, error: null };
  } catch (caughtError) {
    return {
      record: null,
      error: caughtError instanceof Error
        ? caughtError
        : new Error('Saved pending revoke data could not be read.'),
    };
  }
}

export function getRevokeSubmissionAction(walletAddress: Address): RevokeSubmissionAction {
  const loaded = loadPendingRevoke(walletAddress);
  if (loaded.error) return { type: 'blocked', error: loaded.error };
  return loaded.record
    ? { type: 'resume', record: loaded.record }
    : { type: 'submit' };
}

export function ensurePendingRevokeStorage(walletAddress: Address): Error | null {
  if (typeof window === 'undefined') return new Error('Session storage is unavailable; revoke submission is disabled.');
  const probeKey = `${storageKey(walletAddress)}:probe`;
  const probeValue = `ready:${Date.now()}:${Math.random()}`;
  try {
    const storage = window.sessionStorage;
    storage.setItem(probeKey, probeValue);
    if (storage.getItem(probeKey) !== probeValue) {
      throw new Error('Session storage did not preserve the revoke recovery check.');
    }
    storage.removeItem(probeKey);
    if (storage.getItem(probeKey) !== null) {
      throw new Error('Session storage could not clear the revoke recovery check.');
    }
    return null;
  } catch (caughtError) {
    try {
      window.sessionStorage.removeItem(probeKey);
    } catch {
      // Preserve the original storage error.
    }
    return caughtError instanceof Error
      ? caughtError
      : new Error('Session storage could not be verified.');
  }
}

export function savePendingRevoke(record: PendingRevokeRecord): Error | null {
  pendingRevokeByWallet.set(walletKey(record.walletAddress), record);
  const serialized: SerializedPendingRevokeRecord = {
    version: 2,
    walletAddress: record.walletAddress,
    tokenAddress: record.tokenAddress,
    spenderAddress: record.spenderAddress,
    phase: record.phase,
    ...(record.hash === undefined ? {} : { hash: record.hash }),
    ...(record.receiptBlock === undefined ? {} : { receiptBlock: record.receiptBlock.toString() }),
  };
  if (typeof window === 'undefined') return new Error('Pending revoke data cannot be saved outside a browser session.');
  try {
    const storage = window.sessionStorage;
    const key = storageKey(record.walletAddress);
    storage.setItem(key, JSON.stringify(serialized));
    const saved = storage.getItem(key);
    const restored = saved === null
      ? null
      : parsePendingRevokeRecord(JSON.parse(saved) as unknown, record.walletAddress);
    if (
      !restored ||
      restored.phase !== record.phase ||
      restored.walletAddress.toLowerCase() !== record.walletAddress.toLowerCase() ||
      restored.tokenAddress.toLowerCase() !== record.tokenAddress.toLowerCase() ||
      restored.spenderAddress.toLowerCase() !== record.spenderAddress.toLowerCase() ||
      restored.hash?.toLowerCase() !== record.hash?.toLowerCase() ||
      restored.receiptBlock !== record.receiptBlock
    ) {
      throw new Error('Session storage did not preserve the pending revoke record.');
    }
    return null;
  } catch (caughtError) {
    return caughtError instanceof Error
      ? caughtError
      : new Error('Pending revoke data could not be saved.');
  }
}

export function clearPendingRevoke(walletAddress: Address): Error | null {
  if (typeof window === 'undefined') return new Error('Session storage is unavailable; pending revoke state was retained.');
  try {
    const storage = window.sessionStorage;
    const key = storageKey(walletAddress);
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new Error('Pending revoke state could not be cleared.');
    pendingRevokeByWallet.delete(walletKey(walletAddress));
    return null;
  } catch (caughtError) {
    return caughtError instanceof Error
      ? caughtError
      : new Error('Completed revoke data could not be cleared.');
  }
}

export function claimRevokeOperation(walletAddress: Address): boolean {
  const key = walletKey(walletAddress);
  if (activeRevokeWallets.has(key)) return false;
  activeRevokeWallets.add(key);
  return true;
}

export function releaseRevokeOperation(walletAddress: Address): void {
  activeRevokeWallets.delete(walletKey(walletAddress));
}

export function resetPendingRevokeStateForTests(): void {
  pendingRevokeByWallet.clear();
  activeRevokeWallets.clear();
}
