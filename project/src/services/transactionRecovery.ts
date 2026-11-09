import type { Address, Hash, Hex } from 'viem';

export type RecoverableAction = 'send' | 'swap' | 'bridge' | 'gateway-deposit' | 'gateway-fast-deposit' | 'gateway-spend';
export type RecoveryStatus =
  | 'wallet-request'
  | 'pending'
  | 'confirmed'
  | 'reverted'
  | 'timeout'
  | 'rpc-error'
  | 'uncertain';

export interface RecoveredTransaction {
  chainId: number;
  hash: Hash;
  step: string;
}

export interface BridgeRecoveryOperation {
  sourceChainId: number;
  destinationChainId: number;
  recipientAddress: Address;
  route: 'forwarding' | 'cctp';
  amount: string;
  destinationAmount: string;
  circleMessageNonce?: Hex;
  cctpMessageIdentity?: {
    sourceDomain: number;
    nonce: Hex;
    sender: Hex;
    messageBodyHash: Hex;
  };
  destinationVerified?: boolean;
  totalSourceDebit?: string;
  feePayment?: 'source' | 'destination';
}

export interface GatewayRecoveryOperation {
  type: 'fast-deposit' | 'spend';
  recipientAddress: Address;
  expectedToken: Address;
  expectedAmount: string;
  destinationVerified: boolean;
}

export interface TransactionRecoveryRecord {
  operationId: string;
  walletAddress: Address;
  action: RecoverableAction;
  chainIds: number[];
  status: RecoveryStatus;
  transactions: RecoveredTransaction[];
  bridgeOperation?: BridgeRecoveryOperation;
  gatewayOperation?: GatewayRecoveryOperation;
  error?: string;
  updatedAt: number;
}

export type RecoveryContext =
  | { type: 'none' }
  | { type: 'match'; record: TransactionRecoveryRecord }
  | { type: 'chain-mismatch'; record: TransactionRecoveryRecord };

interface SerializedRecoveryRecord extends Omit<TransactionRecoveryRecord, 'version'> {
  version: 1;
}

const STORAGE_KEY_PREFIX = 'orbit:transaction-recovery:v1';
const recoveryByKey = new Map<string, TransactionRecoveryRecord>();

function recoveryKey(walletAddress: Address, action: RecoverableAction): string {
  return `${STORAGE_KEY_PREFIX}:${walletAddress.toLowerCase()}:${action}`;
}

function nextRecoveryUpdatedAt(record: TransactionRecoveryRecord): number {
  return Math.max(Date.now(), record.updatedAt + 1);
}

function recoveryLockName(walletAddress: Address, actions: RecoverableAction[]): string {
  const lockActions = new Set(actions);
  if (lockActions.has('gateway-deposit') || lockActions.has('gateway-fast-deposit')) {
    lockActions.add('gateway-deposit');
    lockActions.add('gateway-fast-deposit');
  }
  const lockScope = [...lockActions].sort().join(',');
  return `${STORAGE_KEY_PREFIX}:claim:${walletAddress.toLowerCase()}:${lockScope}`;
}

function getLegacyOperationId(record: Omit<TransactionRecoveryRecord, 'operationId'>): string {
  const transactions = record.transactions.map(({ chainId, hash, step }) => `${chainId}:${hash.toLowerCase()}:${step}`).join('|');
  return `legacy:${record.updatedAt}:${record.status}:${transactions}:${JSON.stringify([
    record.bridgeOperation,
    record.gatewayOperation,
  ])}`;
}

function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[a-f\d]{40}$/i.test(value);
}

function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && /^0x[a-f\d]{64}$/i.test(value);
}

function isPositiveIntegerString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
  return BigInt(value) > 0n;
}

function isBridgeRecoveryOperation(value: unknown, chainIds: unknown): value is BridgeRecoveryOperation {
  if (!value || typeof value !== 'object' || !Array.isArray(chainIds)) return false;
  const operation = value as Partial<BridgeRecoveryOperation>;
  const identity = operation.cctpMessageIdentity;
  return Number.isSafeInteger(operation.sourceChainId) &&
    Number.isSafeInteger(operation.destinationChainId) &&
    operation.sourceChainId !== operation.destinationChainId &&
    chainIds.includes(operation.sourceChainId) &&
    chainIds.includes(operation.destinationChainId) &&
    isAddress(operation.recipientAddress) &&
    (operation.route === 'forwarding' || operation.route === 'cctp') &&
    isPositiveIntegerString(operation.amount) &&
    isPositiveIntegerString(operation.destinationAmount) &&
    (operation.circleMessageNonce === undefined || /^0x[a-f\d]{64}$/i.test(operation.circleMessageNonce)) &&
    (identity === undefined || (
      typeof identity === 'object' &&
      identity !== null &&
      Number.isSafeInteger(identity.sourceDomain) &&
      identity.sourceDomain >= 0 &&
      /^0x[a-f\d]{64}$/i.test(identity.nonce) &&
      /^0x[a-f\d]{64}$/i.test(identity.sender) &&
      /^0x[a-f\d]{64}$/i.test(identity.messageBodyHash)
    )) &&
    (operation.destinationVerified === undefined || typeof operation.destinationVerified === 'boolean') &&
    (operation.totalSourceDebit === undefined || isPositiveIntegerString(operation.totalSourceDebit)) &&
    (operation.feePayment === undefined || operation.feePayment === 'source' || operation.feePayment === 'destination');
}

function isGatewayRecoveryOperation(
  value: unknown,
  action: unknown,
): value is GatewayRecoveryOperation {
  if (!value || typeof value !== 'object') return false;
  const operation = value as Partial<GatewayRecoveryOperation>;
  return (
    (operation.type === 'fast-deposit' && action === 'gateway-fast-deposit' ||
      operation.type === 'spend' && action === 'gateway-spend') &&
    isAddress(operation.recipientAddress) &&
    isAddress(operation.expectedToken) &&
    isPositiveIntegerString(operation.expectedAmount) &&
    typeof operation.destinationVerified === 'boolean'
  );
}

function parseRecord(value: unknown, walletAddress: Address, action: RecoverableAction): TransactionRecoveryRecord {
  if (typeof value !== 'object' || value === null) throw new Error('Saved transaction recovery data is invalid.');
  const raw = value as Partial<SerializedRecoveryRecord>;
  const actions: RecoverableAction[] = ['send', 'swap', 'bridge', 'gateway-deposit', 'gateway-fast-deposit', 'gateway-spend'];
  const statuses: RecoveryStatus[] = ['wallet-request', 'pending', 'confirmed', 'reverted', 'timeout', 'rpc-error', 'uncertain'];
  if (
    raw.version !== 1 ||
    raw.action !== action ||
    !isAddress(raw.walletAddress) ||
    raw.walletAddress.toLowerCase() !== walletAddress.toLowerCase() ||
    !actions.includes(raw.action) ||
    !statuses.includes(raw.status as RecoveryStatus) ||
    (raw.operationId !== undefined && (typeof raw.operationId !== 'string' || raw.operationId.length === 0)) ||
    !Array.isArray(raw.chainIds) ||
    raw.chainIds.length === 0 ||
    raw.chainIds.some((chainId) => !Number.isSafeInteger(chainId) || chainId <= 0) ||
    !Array.isArray(raw.transactions) ||
    raw.transactions.some((transaction) =>
      typeof transaction !== 'object' ||
      transaction === null ||
      !Number.isSafeInteger(transaction.chainId) ||
      transaction.chainId <= 0 ||
      !isHash(transaction.hash) ||
      typeof transaction.step !== 'string',
    ) ||
    (raw.bridgeOperation !== undefined && !isBridgeRecoveryOperation(raw.bridgeOperation, raw.chainIds)) ||
    (raw.gatewayOperation !== undefined && !isGatewayRecoveryOperation(raw.gatewayOperation, raw.action)) ||
    typeof raw.updatedAt !== 'number' ||
    !Number.isFinite(raw.updatedAt) ||
    (raw.error !== undefined && typeof raw.error !== 'string')
  ) {
    throw new Error('Saved transaction recovery data is invalid; verify wallet activity before submitting again.');
  }
  return {
    operationId: raw.operationId ?? getLegacyOperationId({
      walletAddress: raw.walletAddress,
      action: raw.action,
      chainIds: raw.chainIds,
      status: raw.status as RecoveryStatus,
      transactions: raw.transactions,
      ...(raw.bridgeOperation === undefined ? {} : { bridgeOperation: raw.bridgeOperation }),
      ...(raw.gatewayOperation === undefined ? {} : { gatewayOperation: raw.gatewayOperation }),
      ...(raw.error === undefined ? {} : { error: raw.error }),
      updatedAt: raw.updatedAt,
    }),
    walletAddress: raw.walletAddress,
    action: raw.action,
    chainIds: [...new Set(raw.chainIds)],
    status: raw.status as RecoveryStatus,
    transactions: raw.transactions.map((transaction) => ({ ...transaction })),
    ...(raw.bridgeOperation === undefined ? {} : { bridgeOperation: { ...raw.bridgeOperation } }),
    ...(raw.gatewayOperation === undefined ? {} : { gatewayOperation: { ...raw.gatewayOperation } }),
    ...(raw.error === undefined ? {} : { error: raw.error }),
    updatedAt: raw.updatedAt,
  };
}

export function isRecoveryUnresolved(status: RecoveryStatus): boolean {
  return status !== 'confirmed' && status !== 'reverted';
}

export function isExplicitWalletRejection(error: unknown): boolean {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; cause?: unknown }
    : undefined;
  return candidate?.code === 4001 || candidate?.code === '4001' ||
    (candidate?.cause !== undefined && candidate.cause !== error && isExplicitWalletRejection(candidate.cause));
}

export function isTransactionRecoveryUnresolved(record: TransactionRecoveryRecord): boolean {
  return isRecoveryUnresolved(record.status) ||
    (record.action === 'bridge' && record.status === 'confirmed' && record.bridgeOperation?.destinationVerified !== true) ||
    ((record.action === 'gateway-fast-deposit' || record.action === 'gateway-spend') &&
      record.status === 'confirmed' &&
      record.gatewayOperation?.destinationVerified !== true);
}

export function classifyRecoveryReceipt(
  receipt: { status: 'success' | 'reverted' } | null,
): RecoveryStatus {
  if (!receipt) return 'pending';
  return receipt.status === 'success' ? 'confirmed' : 'reverted';
}

export function classifyRecoveryLookupError(error: unknown): RecoveryStatus {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/timed?\s*out|timeout|deadline exceeded/i.test(message)) return 'timeout';
  if (/transaction receipt.*not found|receipt.*not found|could not be found|not mined/i.test(message)) return 'pending';
  return 'rpc-error';
}

export async function inspectKnownTransactionReceipt<T extends { status: 'success' | 'reverted' }>(
  readReceipt: () => Promise<T | null>,
  timeoutMs = 15_000,
): Promise<{ status: RecoveryStatus; receipt?: T; error?: Error }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const receipt = await Promise.race([
      readReceipt(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Transaction receipt lookup timed out.')), timeoutMs);
      }),
    ]);
    return { status: classifyRecoveryReceipt(receipt), ...(receipt === null ? {} : { receipt }) };
  } catch (caughtError) {
    const error = caughtError instanceof Error ? caughtError : new Error('Transaction receipt lookup failed.');
    return {
      status: classifyRecoveryLookupError(error),
      error,
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function resolveRecoveryContext(
  record: TransactionRecoveryRecord | null,
  walletAddress: Address | undefined,
  chainIds: readonly number[],
): RecoveryContext {
  if (!record || !walletAddress) return { type: 'none' };
  if (record.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) return { type: 'none' };
  const expected = [...new Set(chainIds)].sort((left, right) => left - right);
  const saved = [...record.chainIds].sort((left, right) => left - right);
  return expected.length === saved.length && expected.every((chainId, index) => chainId === saved[index])
    ? { type: 'match', record }
    : { type: 'chain-mismatch', record };
}

export function readTransactionRecovery(
  walletAddress: Address,
  action: RecoverableAction,
): { record: TransactionRecoveryRecord | null; error: Error | null } {
  const key = recoveryKey(walletAddress, action);
  if (typeof window === 'undefined') {
    return { record: null, error: new Error('Transaction recovery storage is unavailable outside a browser session.') };
  }
  try {
    const sharedStorage = window.localStorage;
    let serialized = sharedStorage.getItem(key);
    if (serialized === null) {
      const legacySerialized = window.sessionStorage.getItem(key);
      if (legacySerialized === null) {
        return { record: recoveryByKey.get(key) ?? null, error: null };
      }
      const legacyRecord = parseRecord(JSON.parse(legacySerialized) as unknown, walletAddress, action);
      sharedStorage.setItem(key, JSON.stringify({ version: 1, ...legacyRecord }));
      serialized = sharedStorage.getItem(key);
      if (serialized === null) throw new Error('Saved transaction recovery data could not be shared between tabs.');
    }
    const record = parseRecord(JSON.parse(serialized) as unknown, walletAddress, action);
    recoveryByKey.set(key, record);
    return { record, error: null };
  } catch (caughtError) {
    return {
      record: null,
      error: caughtError instanceof Error ? caughtError : new Error('Transaction recovery data could not be read.'),
    };
  }
}

export function saveTransactionRecovery(record: TransactionRecoveryRecord): Error | null {
  if (!isAddress(record.walletAddress) || !record.chainIds.length || record.chainIds.some((chainId) => !Number.isSafeInteger(chainId) || chainId <= 0)) {
    return new Error('Transaction recovery context is invalid.');
  }
  if (record.bridgeOperation && !isBridgeRecoveryOperation(record.bridgeOperation, record.chainIds)) {
    return new Error('Bridge recovery operation context is invalid.');
  }
  if (record.gatewayOperation && !isGatewayRecoveryOperation(record.gatewayOperation, record.action)) {
    return new Error('Gateway recovery operation context is invalid.');
  }
  if (typeof window === 'undefined') return new Error('Transaction recovery storage is unavailable.');
  const key = recoveryKey(record.walletAddress, record.action);
  const serialized: SerializedRecoveryRecord = {
    version: 1,
    ...record,
    chainIds: [...new Set(record.chainIds)],
    transactions: record.transactions.map((transaction) => ({ ...transaction })),
    updatedAt: record.updatedAt,
  };
  try {
    const storage = window.localStorage;
    storage.setItem(key, JSON.stringify(serialized));
    const saved = storage.getItem(key);
    if (saved === null) throw new Error('Transaction recovery state was not saved.');
    const restored = parseRecord(JSON.parse(saved) as unknown, record.walletAddress, record.action);
    recoveryByKey.set(key, restored);
    return null;
  } catch (caughtError) {
    return caughtError instanceof Error
      ? caughtError
      : new Error('Transaction recovery state could not be saved.');
  }
}

export async function claimTransactionRecovery(
  walletAddress: Address,
  action: RecoverableAction,
  chainIds: number[],
  conflictingActions: RecoverableAction[] = [action],
  bridgeOperation?: BridgeRecoveryOperation,
  gatewayOperation?: GatewayRecoveryOperation,
): Promise<{ claimed: boolean; record: TransactionRecoveryRecord | null; error: Error | null }> {
  const actions = [...new Set([...conflictingActions, action])].sort();
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve({
      claimed: false,
      record: null,
      error: new Error('Cross-tab transaction recovery locking is unavailable. Submission is blocked for safety.'),
    });
  }
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    return {
      claimed: false,
      record: null,
      error: new Error('A unique transaction recovery operation ID could not be created. Submission is blocked for safety.'),
    };
  }
  const lockName = recoveryLockName(walletAddress, actions);
  return navigator.locks.request(lockName, async () => {
    let latestUpdatedAt = 0;
    for (const conflictingAction of actions) {
      const current = readTransactionRecovery(walletAddress, conflictingAction);
      if (current.error) return { claimed: false, record: current.record, error: current.error };
      latestUpdatedAt = Math.max(latestUpdatedAt, current.record?.updatedAt ?? 0);
      if (current.record && isTransactionRecoveryUnresolved(current.record)) {
        return { claimed: false, record: current.record, error: null };
      }
    }
    const record: TransactionRecoveryRecord = {
      operationId: crypto.randomUUID(),
      walletAddress,
      action,
      chainIds: [...new Set(chainIds)],
      status: 'wallet-request',
      transactions: [],
      ...(bridgeOperation ? { bridgeOperation } : {}),
      ...(gatewayOperation ? { gatewayOperation } : {}),
      updatedAt: Math.max(Date.now(), latestUpdatedAt + 1),
    };
    const error = saveTransactionRecovery(record);
    return { claimed: error === null, record: error ? null : record, error };
  }).catch((caughtError) => ({
    claimed: false,
    record: null,
    error: caughtError instanceof Error
      ? caughtError
      : new Error('Cross-tab transaction recovery lock could not be acquired. Submission is blocked for safety.'),
  }));
}

export async function resolveTerminalTransactionRecovery(
  walletAddress: Address,
  actionsToResolve: RecoverableAction[],
  conflictingActions: RecoverableAction[] = actionsToResolve,
): Promise<Error | null> {
  const actions = [...new Set([...conflictingActions, ...actionsToResolve])].sort();
  if (typeof navigator === 'undefined' || !navigator.locks || typeof window === 'undefined') {
    return new Error('Cross-tab transaction recovery locking is unavailable. The recovery lock was not cleared.');
  }
  const lockName = recoveryLockName(walletAddress, actions);
  try {
    return await navigator.locks.request(lockName, async () => {
      const recordsToClear: Array<{ key: string }> = [];
      let foundRecord = false;
      for (const action of actionsToResolve) {
        const current = readTransactionRecovery(walletAddress, action);
        if (current.error) return current.error;
        if (!current.record) continue;
        foundRecord = true;
        if (current.record.transactions.length > 0 || isTransactionRecoveryUnresolved(current.record)) {
          return new Error(
            'Manually verify wallet activity and the relevant explorer, but do not submit again; the recovery record contains a transaction hash or an unresolved outcome and the recovery lock remains in place.',
          );
        }
        recordsToClear.push({ key: recoveryKey(walletAddress, action) });
      }
      if (!foundRecord) return new Error('No transaction recovery record was found to resolve.');
      for (const { key } of recordsToClear) {
        window.localStorage.removeItem(key);
        window.sessionStorage.removeItem(key);
        if (window.localStorage.getItem(key) !== null || window.sessionStorage.getItem(key) !== null) {
          return new Error('Transaction recovery state could not be cleared.');
        }
        recoveryByKey.delete(key);
      }
      return null;
    });
  } catch (caughtError) {
    return caughtError instanceof Error
      ? caughtError
      : new Error('Cross-tab transaction recovery lock could not be acquired. The recovery lock was not cleared.');
  }
}

export async function resolveUnsubmittedTransactionRecovery(
  walletAddress: Address,
  action: RecoverableAction,
  conflictingActions: RecoverableAction[] = [action],
  expectedOperationId?: string,
): Promise<Error | null> {
  const actions = [...new Set([...conflictingActions, action])];
  if (typeof navigator === 'undefined' || !navigator.locks || typeof window === 'undefined') {
    return new Error('Cross-tab transaction recovery locking is unavailable. The recovery lock was not cleared.');
  }
  if (!expectedOperationId) {
    return new Error('The recovery operation identity is unavailable. The recovery lock was not cleared.');
  }
  try {
    return await navigator.locks.request(recoveryLockName(walletAddress, actions), async () => {
      const current = readTransactionRecovery(walletAddress, action);
      if (current.error) return current.error;
      if (!current.record) return new Error('No transaction recovery record was found to resolve.');
      if (current.record.operationId !== expectedOperationId) {
        return new Error('The transaction recovery operation changed. The recovery lock was not cleared.');
      }
      if (current.record.status !== 'wallet-request' || current.record.transactions.length > 0) {
        return new Error(
          'Transaction recovery cannot be cleared because it is not a hashless wallet request; verify wallet activity and keep the recovery lock in place.',
        );
      }

      const key = recoveryKey(walletAddress, action);
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
      if (window.localStorage.getItem(key) !== null || window.sessionStorage.getItem(key) !== null) {
        return new Error('Transaction recovery state could not be cleared.');
      }
      recoveryByKey.delete(key);
      return null;
    });
  } catch (caughtError) {
    return caughtError instanceof Error
      ? caughtError
      : new Error('Cross-tab transaction recovery lock could not be acquired. The recovery lock was not cleared.');
  }
}

export async function resolveLegacyBridgeRecovery(
  walletAddress: Address,
  expectedOperationId: string,
  expectedUpdatedAt: number,
  expectedTransactions: readonly RecoveredTransaction[],
): Promise<Error | null> {
  if (typeof navigator === 'undefined' || !navigator.locks || typeof window === 'undefined') {
    return new Error('Cross-tab transaction recovery locking is unavailable. The recovery lock was not cleared.');
  }
  try {
    return await navigator.locks.request(recoveryLockName(walletAddress, ['bridge']), async () => {
      const current = readTransactionRecovery(walletAddress, 'bridge');
      if (current.error) return current.error;
      if (
        !current.record ||
        current.record.operationId !== expectedOperationId ||
        current.record.updatedAt !== expectedUpdatedAt ||
        current.record.bridgeOperation ||
        current.record.transactions.length !== expectedTransactions.length ||
        current.record.transactions.some((transaction, index) => {
          const expected = expectedTransactions[index];
          return transaction.chainId !== expected.chainId ||
            transaction.hash.toLowerCase() !== expected.hash.toLowerCase() ||
            transaction.step !== expected.step;
        })
      ) {
        return new Error('The saved legacy Bridge recovery changed. Its recovery lock was not cleared.');
      }

      const key = recoveryKey(walletAddress, 'bridge');
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
      if (window.localStorage.getItem(key) !== null || window.sessionStorage.getItem(key) !== null) {
        return new Error('Legacy Bridge recovery state could not be cleared.');
      }
      recoveryByKey.delete(key);
      return null;
    });
  } catch (caughtError) {
    return caughtError instanceof Error
      ? caughtError
      : new Error('Cross-tab transaction recovery lock could not be acquired. The recovery lock was not cleared.');
  }
}

export async function updateTransactionRecoveryIfCurrent(
  walletAddress: Address,
  action: RecoverableAction,
  expectedOperationId: string,
  update: Partial<Pick<TransactionRecoveryRecord, 'status' | 'chainIds' | 'transactions' | 'bridgeOperation' | 'gatewayOperation' | 'error'>>,
  expectedUpdatedAt?: number,
): Promise<{ record: TransactionRecoveryRecord | null; error: Error | null; stale: boolean }> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return {
      record: null,
      error: new Error('Cross-tab transaction recovery locking is unavailable. Recovery state was not updated.'),
      stale: false,
    };
  }
  try {
    return await navigator.locks.request(recoveryLockName(walletAddress, [action]), async () => {
      const current = readTransactionRecovery(walletAddress, action);
      if (current.error || !current.record) {
        return {
          record: current.record,
          error: current.error ?? new Error('Transaction recovery intent is missing.'),
          stale: false,
        };
      }
      if (current.record.operationId !== expectedOperationId ||
        expectedUpdatedAt !== undefined && current.record.updatedAt !== expectedUpdatedAt) {
        return {
          record: current.record,
          error: new Error('The transaction recovery operation changed. A stale result was ignored.'),
          stale: true,
        };
      }
      const record: TransactionRecoveryRecord = {
        ...current.record,
        ...update,
        transactions: (update.transactions ?? current.record.transactions).map((transaction) => ({ ...transaction })),
        updatedAt: nextRecoveryUpdatedAt(current.record),
      };
      const error = saveTransactionRecovery(record);
      return { record: error ? current.record : record, error, stale: false };
    });
  } catch (caughtError) {
    return {
      record: null,
      error: caughtError instanceof Error
        ? caughtError
        : new Error('Cross-tab transaction recovery lock could not be acquired. Recovery state was not updated.'),
      stale: false,
    };
  }
}

export function updateTransactionRecovery(
  walletAddress: Address,
  action: RecoverableAction,
  update: Partial<Pick<TransactionRecoveryRecord, 'status' | 'chainIds' | 'transactions' | 'bridgeOperation' | 'gatewayOperation' | 'error'>>,
): { record: TransactionRecoveryRecord | null; error: Error | null } {
  const current = readTransactionRecovery(walletAddress, action);
  if (current.error || !current.record) {
    return { record: current.record, error: current.error ?? new Error('Transaction recovery intent is missing.') };
  }
  const record: TransactionRecoveryRecord = {
    ...current.record,
    ...update,
    transactions: (update.transactions ?? current.record.transactions).map((transaction) => ({ ...transaction })),
    updatedAt: nextRecoveryUpdatedAt(current.record),
  };
  const error = saveTransactionRecovery(record);
  return { record: error ? current.record : record, error };
}

export function resetTransactionRecoveryCacheForTests(): void {
  recoveryByKey.clear();
}
