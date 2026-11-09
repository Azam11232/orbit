import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hash, Hex } from 'viem';
import {
  claimTransactionRecovery,
  classifyRecoveryLookupError,
  classifyRecoveryReceipt,
  isExplicitWalletRejection,
  isRecoveryUnresolved,
  inspectKnownTransactionReceipt,
  readTransactionRecovery,
  isTransactionRecoveryUnresolved,
  resolveLegacyBridgeRecovery,
  resolveTerminalTransactionRecovery,
  resolveUnsubmittedTransactionRecovery,
  resolveRecoveryContext,
  resetTransactionRecoveryCacheForTests,
  updateTransactionRecovery,
  updateTransactionRecoveryIfCurrent,
  type TransactionRecoveryRecord,
} from './transactionRecovery';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const otherWallet = '0x2222222222222222222222222222222222222222' as Address;
const hash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

function memoryLockManager() {
  const tails = new Map<string, Promise<void>>();
  return {
    request: vi.fn(<T>(name: string, callback: () => Promise<T> | T): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release = () => {};
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(name, previous.then(() => current));
      return previous.then(callback).finally(release);
    }),
  };
}

let locks: ReturnType<typeof memoryLockManager>;
let localStorage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  resetTransactionRecoveryCacheForTests();
  localStorage = memoryStorage();
  vi.stubGlobal('window', { localStorage, sessionStorage: memoryStorage() });
  locks = memoryLockManager();
  vi.stubGlobal('navigator', { locks });
});

describe('transaction recovery persistence', () => {
  it('recognizes wallet rejection only from structured provider evidence', () => {
    expect(isExplicitWalletRejection({ code: 4001 })).toBe(true);
    expect(isExplicitWalletRejection({ cause: { code: '4001' } })).toBe(true);
    expect(isExplicitWalletRejection(new Error('User rejected the request'))).toBe(false);
    expect(isExplicitWalletRejection({ code: -32000, message: 'user rejected' })).toBe(false);
  });

  it('restores a submitted hash after the in-memory cache is cleared', async () => {
    const claim = await claimTransactionRecovery(wallet, 'send', [5042002]);
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'send', {
      status: 'pending',
      transactions: [{ chainId: 5042002, hash, step: 'send' }],
    }).error).toBeNull();

    resetTransactionRecoveryCacheForTests();

    expect(readTransactionRecovery(wallet, 'send').record).toMatchObject({
      walletAddress: wallet,
      action: 'send',
      chainIds: [5042002],
      status: 'pending',
      transactions: [{ chainId: 5042002, hash, step: 'send' }],
    });
    await expect(claimTransactionRecovery(wallet, 'send', [5042002])).resolves.toMatchObject({
      claimed: false,
      record: { transactions: [{ hash }] },
    });
  });

  it('persists the Bridge recipient and route with the unresolved transaction', async () => {
    const operation = {
      sourceChainId: 5042002,
      destinationChainId: 84532,
      recipientAddress: otherWallet,
      route: 'forwarding' as const,
      amount: '1000000',
      destinationAmount: '990000',
      circleMessageNonce: `0x${'0'.repeat(63)}1` as Hex,
      cctpMessageIdentity: {
        sourceDomain: 6,
        nonce: `0x${'0'.repeat(63)}2` as Hex,
        sender: `0x${'0'.repeat(64)}` as Hex,
        messageBodyHash: `0x${'0'.repeat(64)}` as Hex,
      },
      feePayment: 'destination' as const,
    };
    const claim = await claimTransactionRecovery(wallet, 'bridge', [5042002, 84532], undefined, operation);
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'bridge', {
      status: 'pending',
      transactions: [{ chainId: 5042002, hash, step: 'burn' }],
    }).error).toBeNull();

    resetTransactionRecoveryCacheForTests();

    expect(readTransactionRecovery(wallet, 'bridge').record?.bridgeOperation).toEqual(operation);
    await expect(claimTransactionRecovery(wallet, 'bridge', [5042002, 84532], undefined, operation)).resolves.toMatchObject({
      claimed: false,
      record: {
        status: 'pending',
        transactions: [{ chainId: 5042002, hash, step: 'burn' }],
      },
    });
  });

  it('persists exact Gateway receipt expectations and keeps unverified confirmations unresolved', async () => {
    const operation = {
      type: 'spend' as const,
      recipientAddress: wallet,
      expectedToken: otherWallet,
      expectedAmount: '9007199254740993',
      destinationVerified: false,
    };
    const claim = await claimTransactionRecovery(
      wallet,
      'gateway-spend',
      [5042002, 84532],
      undefined,
      undefined,
      operation,
    );
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'gateway-spend', {
      status: 'confirmed',
      transactions: [{ chainId: 84532, hash, step: 'mint' }],
    }).error).toBeNull();
    expect(isTransactionRecoveryUnresolved(readTransactionRecovery(wallet, 'gateway-spend').record!)).toBe(true);

    resetTransactionRecoveryCacheForTests();

    expect(readTransactionRecovery(wallet, 'gateway-spend').record?.gatewayOperation).toEqual(operation);
    expect(updateTransactionRecovery(wallet, 'gateway-spend', {
      gatewayOperation: { ...operation, destinationVerified: true },
    }).error).toBeNull();
    expect(isTransactionRecoveryUnresolved(readTransactionRecovery(wallet, 'gateway-spend').record!)).toBe(false);
  });

  it('keeps legacy Gateway confirmations without saved expected amounts unresolved', async () => {
    const claim = await claimTransactionRecovery(wallet, 'gateway-fast-deposit', [11155111, 5042002]);
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'gateway-fast-deposit', {
      status: 'confirmed',
      transactions: [{ chainId: 5042002, hash, step: 'destination' }],
    }).error).toBeNull();
    expect(isTransactionRecoveryUnresolved(readTransactionRecovery(wallet, 'gateway-fast-deposit').record!)).toBe(true);
  });

  it('keeps unverified legacy Bridge records locked even if their saved status says confirmed', async () => {
    const claim = await claimTransactionRecovery(wallet, 'bridge', [5042002, 84532]);
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'bridge', {
      status: 'confirmed',
      transactions: [{ chainId: 84532, hash, step: 'mint' }],
    }).error).toBeNull();

    const record = readTransactionRecovery(wallet, 'bridge').record!;
    expect(isTransactionRecoveryUnresolved(record)).toBe(true);
    await expect(claimTransactionRecovery(wallet, 'bridge', [5042002, 84532])).resolves.toMatchObject({
      claimed: false,
      record: { status: 'confirmed' },
    });
    await expect(resolveTerminalTransactionRecovery(wallet, ['bridge'])).resolves.toMatchObject({
      message: expect.stringContaining('the recovery lock remains in place'),
    });

    expect(updateTransactionRecovery(wallet, 'bridge', {
      bridgeOperation: {
        sourceChainId: 5042002,
        destinationChainId: 84532,
        recipientAddress: otherWallet,
        route: 'forwarding',
        amount: '1000000',
        destinationAmount: '990000',
        destinationVerified: true,
      },
    }).error).toBeNull();
    expect(isTransactionRecoveryUnresolved(readTransactionRecovery(wallet, 'bridge').record!)).toBe(false);
  });

  it('blocks duplicate submissions for all unresolved outcomes', async () => {
    const claim = await claimTransactionRecovery(wallet, 'swap', [5042002]);
    expect(claim.claimed).toBe(true);
    await expect(claimTransactionRecovery(wallet, 'swap', [5042002])).resolves.toMatchObject({
      claimed: false,
      record: { status: 'wallet-request' },
    });
    expect(isRecoveryUnresolved('pending')).toBe(true);
    expect(isRecoveryUnresolved('timeout')).toBe(true);
    expect(isRecoveryUnresolved('rpc-error')).toBe(true);
    expect(isRecoveryUnresolved('uncertain')).toBe(true);
    expect(isRecoveryUnresolved('confirmed')).toBe(false);
    expect(isRecoveryUnresolved('reverted')).toBe(false);
  });

  it('does not apply a recovery record to a different wallet or chain context', () => {
    const record: TransactionRecoveryRecord = {
      operationId: 'bridge-test-operation',
      walletAddress: wallet,
      action: 'bridge',
      chainIds: [5042002, 11155111],
      status: 'pending',
      transactions: [{ chainId: 5042002, hash, step: 'source' }],
      updatedAt: Date.now(),
    };
    expect(resolveRecoveryContext(record, otherWallet, [5042002, 11155111])).toEqual({ type: 'none' });
    expect(resolveRecoveryContext(record, wallet, [5042002])).toMatchObject({ type: 'chain-mismatch' });
    expect(resolveRecoveryContext(record, wallet, [11155111, 5042002])).toMatchObject({ type: 'match' });
  });

  it('does not replace an unresolved transaction from a different chain route', async () => {
    const claim = await claimTransactionRecovery(wallet, 'bridge', [5042002, 11155111]);
    expect(claim.claimed).toBe(true);
    updateTransactionRecovery(wallet, 'bridge', {
      status: 'pending',
      transactions: [{ chainId: 5042002, hash, step: 'source' }],
    });

    await expect(claimTransactionRecovery(wallet, 'bridge', [5042002, 84532])).resolves.toMatchObject({
      claimed: false,
      record: { chainIds: [5042002, 11155111], transactions: [{ hash }] },
    });
  });

  it('clears only the unchanged legacy Bridge record after explicit resolution', async () => {
    const claim = await claimTransactionRecovery(wallet, 'bridge', [5042002, 84532]);
    expect(claim.claimed).toBe(true);
    const transaction = { chainId: 5042002, hash, step: 'burn' };
    expect(updateTransactionRecovery(wallet, 'bridge', {
      status: 'pending',
      transactions: [transaction],
    }).error).toBeNull();
    const saved = readTransactionRecovery(wallet, 'bridge').record!;

    await expect(resolveLegacyBridgeRecovery(
      wallet,
      saved.operationId,
      saved.updatedAt - 1,
      [transaction],
    )).resolves.toMatchObject({ message: expect.stringContaining('changed') });
    expect(readTransactionRecovery(wallet, 'bridge').record?.transactions).toEqual([transaction]);

    await expect(resolveLegacyBridgeRecovery(
      wallet,
      saved.operationId,
      saved.updatedAt,
      [transaction],
    )).resolves.toBeNull();
    expect(readTransactionRecovery(wallet, 'bridge').record).toBeNull();
  });

  it.each(['send', 'bridge'] as const)('ignores a delayed %s update after a newer operation replaces it', async (action) => {
    const chainIds = action === 'bridge' ? [5042002, 84532] : [5042002];
    const bridgeOperation = action === 'bridge'
      ? {
          sourceChainId: 5042002,
          destinationChainId: 84532,
          recipientAddress: wallet,
          route: 'forwarding' as const,
          amount: '1',
          destinationAmount: '1',
          destinationVerified: true,
        }
      : undefined;
    const first = await claimTransactionRecovery(wallet, action, chainIds, [action], bridgeOperation);
    expect(first.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, action, { status: 'confirmed' }).error).toBeNull();

    const second = await claimTransactionRecovery(wallet, action, chainIds, [action], bridgeOperation);
    expect(second.claimed).toBe(true);
    expect(second.record?.operationId).not.toBe(first.record?.operationId);

    const stale = await updateTransactionRecoveryIfCurrent(wallet, action, first.record!.operationId, {
      status: 'rpc-error',
      error: 'late result from prior operation',
    });

    expect(stale.stale).toBe(true);
    expect(readTransactionRecovery(wallet, action).record).toMatchObject({
      operationId: second.record?.operationId,
      status: 'wallet-request',
      transactions: [],
    });
    await expect(resolveUnsubmittedTransactionRecovery(
      wallet,
      action,
      [action],
      first.record!.operationId,
    )).resolves.toMatchObject({ message: expect.stringContaining('operation changed') });
    expect(readTransactionRecovery(wallet, action).record?.operationId).toBe(second.record?.operationId);
  });

  it('ignores a delayed update when the inspected record changed within the same operation', async () => {
    vi.useFakeTimers();
    try {
      const claim = await claimTransactionRecovery(wallet, 'send', [5042002]);
      const inspected = claim.record!;
      expect(updateTransactionRecovery(wallet, 'send', {
        status: 'pending',
        transactions: [{ chainId: 5042002, hash, step: 'send' }],
      }).error).toBeNull();

      const stale = await updateTransactionRecoveryIfCurrent(
        wallet,
        'send',
        inspected.operationId,
        { status: 'confirmed' },
        inspected.updatedAt,
      );

      expect(stale.stale).toBe(true);
      expect(readTransactionRecovery(wallet, 'send').record).toMatchObject({
        operationId: inspected.operationId,
        status: 'pending',
        transactions: [{ hash }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late Bridge receipt result after forwarding state changed within the same operation', async () => {
    const bridgeOperation = {
      sourceChainId: 5042002,
      destinationChainId: 84532,
      recipientAddress: wallet,
      route: 'forwarding' as const,
      amount: '1',
      destinationAmount: '1',
    };
    const claim = await claimTransactionRecovery(
      wallet,
      'bridge',
      [5042002, 84532],
      ['bridge'],
      bridgeOperation,
    );
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'bridge', {
      status: 'pending',
      transactions: [{ chainId: 5042002, hash, step: 'burn' }],
    }).error).toBeNull();
    const inspected = readTransactionRecovery(wallet, 'bridge').record!;

    expect(updateTransactionRecovery(wallet, 'bridge', {
      status: 'pending',
      error: 'forwarding is still being reconciled',
    }).error).toBeNull();
    const lateReceipt = await updateTransactionRecoveryIfCurrent(
      wallet,
      'bridge',
      inspected.operationId,
      {
        status: 'confirmed',
        bridgeOperation: { ...bridgeOperation, destinationVerified: true },
      },
      inspected.updatedAt,
    );

    expect(lateReceipt.stale).toBe(true);
    expect(readTransactionRecovery(wallet, 'bridge').record).toMatchObject({
      operationId: inspected.operationId,
      status: 'pending',
      transactions: [{ hash, step: 'burn' }],
      error: 'forwarding is still being reconciled',
    });
    expect(readTransactionRecovery(wallet, 'bridge').record?.bridgeOperation?.destinationVerified).toBeUndefined();
  });

  it.each(['send', 'bridge'] as const)('allows a new %s operation after a verified terminal record', async (action) => {
    const initial = await claimTransactionRecovery(wallet, action, action === 'bridge' ? [5042002, 84532] : [5042002]);
    expect(initial.claimed).toBe(true);
    const terminalUpdate = action === 'bridge'
      ? updateTransactionRecovery(wallet, action, {
          status: 'confirmed',
          transactions: [{ chainId: 5042002, hash, step: 'source' }],
          bridgeOperation: {
            sourceChainId: 5042002,
            destinationChainId: 84532,
            recipientAddress: otherWallet,
            route: 'cctp',
            amount: '1000000',
            destinationAmount: '1000000',
            destinationVerified: true,
          },
        })
      : updateTransactionRecovery(wallet, action, {
          status: 'reverted',
          transactions: [{ chainId: 5042002, hash, step: 'send' }],
        });
    expect(terminalUpdate.error).toBeNull();

    const next = await claimTransactionRecovery(wallet, action, action === 'bridge' ? [5042002, 84532] : [5042002]);
    expect(next.claimed).toBe(true);
    expect(next.record?.operationId).not.toBe(initial.record?.operationId);
  });

  it('allows a deliberate new submission only after confirmed or reverted terminal status', async () => {
    const claim = await claimTransactionRecovery(wallet, 'gateway-deposit', [5042002]);
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'gateway-deposit', { status: 'reverted' }).error).toBeNull();
    expect((await claimTransactionRecovery(wallet, 'gateway-deposit', [5042002])).claimed).toBe(true);
  });

  it('serializes competing claims from separate tabs using shared storage and Web Locks', async () => {
    const sharedStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage: sharedStorage, sessionStorage: memoryStorage() });
    vi.stubGlobal('navigator', { locks: memoryLockManager() });

    const [firstTab, secondTab] = await Promise.all([
      claimTransactionRecovery(wallet, 'send', [5042002]),
      claimTransactionRecovery(wallet, 'send', [5042002]),
    ]);

    expect([firstTab.claimed, secondTab.claimed].filter(Boolean)).toHaveLength(1);
    expect([firstTab.claimed, secondTab.claimed].filter((claimed) => !claimed)).toHaveLength(1);
    expect(sharedStorage.setItem).toHaveBeenCalledOnce();
  });

  it('serializes terminal Bridge reset resolution with a new cross-tab claim', async () => {
    const sharedStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage: sharedStorage, sessionStorage: memoryStorage() });
    vi.stubGlobal('navigator', { locks: memoryLockManager() });
    const initialClaim = await claimTransactionRecovery(wallet, 'bridge', [5042002, 84532]);
    expect(initialClaim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'bridge', { status: 'reverted' }).error).toBeNull();

    const [resetError, nextClaim] = await Promise.all([
      resolveTerminalTransactionRecovery(wallet, ['bridge']),
      claimTransactionRecovery(wallet, 'bridge', [5042002, 84532]),
    ]);

    expect(resetError).toBeNull();
    expect(nextClaim.claimed).toBe(true);
    expect(readTransactionRecovery(wallet, 'bridge').record).toMatchObject({
      status: 'wallet-request',
      transactions: [],
    });
  });

  it('keeps a timed-out Bridge receipt unresolved and blocks a new source submission', async () => {
    const claim = await claimTransactionRecovery(wallet, 'bridge', [5042002, 84532]);
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'bridge', {
      status: 'timeout',
      transactions: [{ chainId: 5042002, hash, step: 'source' }],
      error: 'Source receipt outcome is unknown.',
    }).error).toBeNull();

    expect(isTransactionRecoveryUnresolved(readTransactionRecovery(wallet, 'bridge').record!)).toBe(true);
    await expect(claimTransactionRecovery(wallet, 'bridge', [5042002, 84532])).resolves.toMatchObject({
      claimed: false,
      record: { status: 'timeout', transactions: [{ hash }] },
    });
  });

  it('fails closed when cross-tab locking is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    await expect(claimTransactionRecovery(wallet, 'send', [5042002])).resolves.toMatchObject({
      claimed: false,
      error: new Error('Cross-tab transaction recovery locking is unavailable. Submission is blocked for safety.'),
    });
  });

  it('keeps stale hashless wallet requests locked because age is not proof of failure', async () => {
    const claim = await claimTransactionRecovery(wallet, 'send', [5042002]);
    expect(claim.claimed).toBe(true);
    const key = 'orbit:transaction-recovery:v1:0x1111111111111111111111111111111111111111:send';
    const staleRecord = {
      version: 1,
      ...claim.record,
      updatedAt: 1,
    };
    window.localStorage.setItem(key, JSON.stringify(staleRecord));

    await expect(claimTransactionRecovery(wallet, 'send', [5042002])).resolves.toMatchObject({
      claimed: false,
      record: { status: 'wallet-request', updatedAt: 1 },
    });
    await expect(resolveTerminalTransactionRecovery(wallet, ['send'])).resolves.toMatchObject({
      message: expect.stringContaining('the recovery lock remains in place'),
    });
    await expect(claimTransactionRecovery(wallet, 'send', [5042002])).resolves.toMatchObject({
      claimed: false,
      record: { status: 'wallet-request', updatedAt: 1 },
    });
  });

  it('blocks standard and fast Gateway deposits against either unresolved mode', async () => {
    const depositActions = ['gateway-deposit', 'gateway-fast-deposit'] as const;
    const standardClaim = await claimTransactionRecovery(wallet, 'gateway-deposit', [5042002], [...depositActions]);
    expect(standardClaim.claimed).toBe(true);
    await expect(claimTransactionRecovery(wallet, 'gateway-fast-deposit', [11155111, 5042002], [...depositActions])).resolves.toMatchObject({
      claimed: false,
      record: { action: 'gateway-deposit', status: 'wallet-request', transactions: [] },
    });

    expect(updateTransactionRecovery(wallet, 'gateway-deposit', { status: 'confirmed' }).error).toBeNull();
    expect(await resolveTerminalTransactionRecovery(wallet, [...depositActions], [...depositActions])).toBeNull();
    const fastClaim = await claimTransactionRecovery(wallet, 'gateway-fast-deposit', [11155111, 5042002], [...depositActions]);
    expect(fastClaim.claimed).toBe(true);
    await expect(claimTransactionRecovery(wallet, 'gateway-deposit', [5042002], [...depositActions])).resolves.toMatchObject({
      claimed: false,
      record: { action: 'gateway-fast-deposit', status: 'wallet-request', transactions: [] },
    });
  });

  it.each([
    ['pending', 'pending' as const],
    ['timeout', 'timeout' as const],
    ['RPC error', 'rpc-error' as const],
    ['uncertain', 'uncertain' as const],
  ])('does not clear a %s transaction outcome', async (label, status) => {
    const claim = await claimTransactionRecovery(wallet, 'send', [5042002]);
    expect(claim.claimed).toBe(true);
    const observedStatus = label === 'pending'
      ? (await inspectKnownTransactionReceipt(async () => null)).status
      : label === 'timeout'
        ? classifyRecoveryLookupError(new Error('Transaction confirmation timed out'))
        : label === 'RPC error'
          ? classifyRecoveryLookupError(new Error('RPC connection reset'))
          : status;
    expect(updateTransactionRecovery(wallet, 'send', {
      status: observedStatus,
      transactions: [{ chainId: 5042002, hash, step: 'send' }],
    }).error).toBeNull();

    await expect(resolveTerminalTransactionRecovery(wallet, ['send'])).resolves.toMatchObject({
      message: expect.stringContaining('the recovery lock remains in place'),
    });
    expect(readTransactionRecovery(wallet, 'send').record).toMatchObject({
      status: observedStatus,
      transactions: [{ hash }],
    });
    await expect(claimTransactionRecovery(wallet, 'send', [5042002])).resolves.toMatchObject({
      claimed: false,
      record: { status: observedStatus },
    });
  });

  it.each(['confirmed', 'reverted'] as const)('retains the hash for a verified %s transaction outcome', async (status) => {
    const claim = await claimTransactionRecovery(wallet, 'send', [5042002]);
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'send', {
      status: classifyRecoveryReceipt({ status: status === 'confirmed' ? 'success' : 'reverted' }),
      transactions: [{ chainId: 5042002, hash, step: 'send' }],
    }).error).toBeNull();

    await expect(resolveTerminalTransactionRecovery(wallet, ['send'])).resolves.toMatchObject({
      message: expect.stringContaining('contains a transaction hash'),
    });
    expect(readTransactionRecovery(wallet, 'send').record).toMatchObject({
      status,
      transactions: [{ hash }],
    });
  });

  it('does not clear an unresolved later Bridge stage when the source transaction is confirmed', async () => {
    const claim = await claimTransactionRecovery(wallet, 'bridge', [5042002, 11155111]);
    expect(claim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'bridge', {
      status: 'pending',
      transactions: [
        { chainId: 5042002, hash, step: 'source' },
        { chainId: 11155111, hash: `0x${'b'.repeat(64)}` as Hash, step: 'destination' },
      ],
      error: 'Source confirmed; destination outcome remains unresolved.',
    }).error).toBeNull();

    await expect(resolveTerminalTransactionRecovery(wallet, ['bridge'])).resolves.toMatchObject({
      message: expect.stringContaining('the recovery lock remains in place'),
    });
    expect(readTransactionRecovery(wallet, 'bridge').record).toMatchObject({
      status: 'pending',
      transactions: [{ step: 'source', hash }, { step: 'destination' }],
    });
  });

  it('does not clear a terminal Gateway record if the other deposit mode is unresolved', async () => {
    const depositActions = ['gateway-deposit', 'gateway-fast-deposit'] as const;
    const standardClaim = await claimTransactionRecovery(wallet, 'gateway-deposit', [5042002], [...depositActions]);
    expect(standardClaim.claimed).toBe(true);
    expect(updateTransactionRecovery(wallet, 'gateway-deposit', { status: 'confirmed' }).error).toBeNull();
    const fastClaim = await claimTransactionRecovery(wallet, 'gateway-fast-deposit', [5042002, 11155111], [...depositActions]);
    expect(fastClaim.claimed).toBe(true);

    await expect(resolveTerminalTransactionRecovery(wallet, [...depositActions], [...depositActions])).resolves.toMatchObject({
      message: expect.stringContaining('the recovery lock remains in place'),
    });
    expect(readTransactionRecovery(wallet, 'gateway-deposit').record?.status).toBe('confirmed');
    expect(readTransactionRecovery(wallet, 'gateway-fast-deposit').record?.status).toBe('wallet-request');
  });

  it('distinguishes a missing receipt, successful receipt, reverted receipt, timeout, and RPC failure', () => {
    expect(classifyRecoveryReceipt(null)).toBe('pending');
    expect(classifyRecoveryReceipt({ status: 'success' })).toBe('confirmed');
    expect(classifyRecoveryReceipt({ status: 'reverted' })).toBe('reverted');
    expect(classifyRecoveryLookupError(new Error('Transaction confirmation timed out'))).toBe('timeout');
    expect(classifyRecoveryLookupError(new Error('Transaction receipt not found'))).toBe('pending');
    expect(classifyRecoveryLookupError(new Error('RPC connection reset'))).toBe('rpc-error');
  });

  it('clears only a hashless wallet-request under the same lock used by claims', async () => {
    const claim = await claimTransactionRecovery(wallet, 'gateway-deposit', [5042002], [
      'gateway-deposit',
      'gateway-fast-deposit',
    ]);
    expect(claim.claimed).toBe(true);

    await expect(resolveUnsubmittedTransactionRecovery(wallet, 'gateway-deposit', [
      'gateway-deposit',
      'gateway-fast-deposit',
    ], claim.record!.operationId)).resolves.toBeNull();

    expect(readTransactionRecovery(wallet, 'gateway-deposit').record).toBeNull();
    expect(locks.request.mock.calls[1][0]).toBe(locks.request.mock.calls[0][0]);
  });

  it.each([
    'send',
    'swap',
    'bridge',
    'gateway-deposit',
    'gateway-fast-deposit',
    'gateway-spend',
  ] as const)('preserves pre-submission cancellation for a hashless %s request', async (action) => {
    const claim = await claimTransactionRecovery(wallet, action, [5042002]);
    expect(claim.claimed).toBe(true);

    await expect(resolveUnsubmittedTransactionRecovery(wallet, action, [action], claim.record!.operationId)).resolves.toBeNull();
    expect(readTransactionRecovery(wallet, action).record).toBeNull();
  });

  it('fails closed when the recovery lock is unavailable', async () => {
    await claimTransactionRecovery(wallet, 'send', [5042002]);
    vi.stubGlobal('navigator', {});

    await expect(resolveUnsubmittedTransactionRecovery(wallet, 'send', ['send'], 'missing')).resolves.toMatchObject({
      message: expect.stringContaining('Cross-tab transaction recovery locking is unavailable'),
    });
    expect(readTransactionRecovery(wallet, 'send').record).toMatchObject({
      status: 'wallet-request',
      transactions: [],
    });
  });

  it('surfaces storage cleanup errors and retains the in-memory recovery record', async () => {
    await claimTransactionRecovery(wallet, 'send', [5042002]);
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    await expect(resolveUnsubmittedTransactionRecovery(wallet, 'send', ['send'], readTransactionRecovery(wallet, 'send').record!.operationId)).resolves.toEqual(
      new Error('storage unavailable'),
    );
    expect(readTransactionRecovery(wallet, 'send').record).toMatchObject({
      status: 'wallet-request',
      transactions: [],
    });
  });

  it.each([
    ['wallet-request', 'wallet-request' as const],
    ['pending', 'pending' as const],
    ['confirmed', 'confirmed' as const],
    ['reverted', 'reverted' as const],
    ['timeout', 'timeout' as const],
    ['RPC error', 'rpc-error' as const],
    ['uncertain', 'uncertain' as const],
  ])('never clears a %s record that contains a transaction hash', async (_label, status) => {
    await claimTransactionRecovery(wallet, 'gateway-deposit', [5042002]);
    expect(updateTransactionRecovery(wallet, 'gateway-deposit', {
      status,
      transactions: [{ chainId: 5042002, hash, step: 'approval' }],
    }).error).toBeNull();

    await expect(resolveUnsubmittedTransactionRecovery(wallet, 'gateway-deposit', ['gateway-deposit'], readTransactionRecovery(wallet, 'gateway-deposit').record!.operationId)).resolves.toMatchObject({
      message: expect.stringContaining('hashless wallet request'),
    });
    expect(readTransactionRecovery(wallet, 'gateway-deposit').record).toMatchObject({
      status,
      transactions: [{ hash, step: 'approval' }],
    });
  });

  it.each(['pending', 'confirmed', 'reverted', 'timeout', 'rpc-error', 'uncertain'] as const)(
    'does not clear a hashless %s record as a wallet cancellation',
    async (status) => {
      await claimTransactionRecovery(wallet, 'send', [5042002]);
      expect(updateTransactionRecovery(wallet, 'send', { status }).error).toBeNull();

      await expect(resolveUnsubmittedTransactionRecovery(wallet, 'send', ['send'], readTransactionRecovery(wallet, 'send').record!.operationId)).resolves.toMatchObject({
        message: expect.stringContaining('hashless wallet request'),
      });
      expect(readTransactionRecovery(wallet, 'send').record?.status).toBe(status);
    },
  );

  it('preserves a submitted Gateway approval when saving the next wallet intent fails', async () => {
    await claimTransactionRecovery(wallet, 'gateway-deposit', [5042002]);
    expect(updateTransactionRecovery(wallet, 'gateway-deposit', {
      status: 'confirmed',
      transactions: [{ chainId: 5042002, hash, step: 'approval' }],
    }).error).toBeNull();

    const originalSetItem = localStorage.setItem.getMockImplementation();
    if (!originalSetItem) throw new Error('Test storage implementation is unavailable.');
    localStorage.setItem.mockImplementation((key, value) => {
      const saved = JSON.parse(value) as { status?: string };
      if (saved.status === 'wallet-request') throw new Error('quota');
      return originalSetItem(key, value);
    });
    expect(updateTransactionRecovery(wallet, 'gateway-deposit', {
      status: 'wallet-request',
      transactions: [],
    }).error).toEqual(new Error('quota'));

    await expect(resolveUnsubmittedTransactionRecovery(wallet, 'gateway-deposit', ['gateway-deposit'], readTransactionRecovery(wallet, 'gateway-deposit').record!.operationId)).resolves.toMatchObject({
      message: expect.stringContaining('hashless wallet request'),
    });
    expect(readTransactionRecovery(wallet, 'gateway-deposit').record).toMatchObject({
      status: 'confirmed',
      transactions: [{ hash, step: 'approval' }],
    });
  });

  it('checks known hashes without resubmitting and treats an unresolved lookup as pending', async () => {
    const readReceipt = vi.fn().mockResolvedValue(null);
    await expect(inspectKnownTransactionReceipt(readReceipt)).resolves.toMatchObject({ status: 'pending' });
    expect(readReceipt).toHaveBeenCalledOnce();
  });

  it('keeps state intact when storage writes fail', async () => {
    const storage = memoryStorage();
    storage.setItem.mockImplementation(() => { throw new Error('quota'); });
    vi.stubGlobal('window', { localStorage: storage, sessionStorage: memoryStorage() });
    await expect(claimTransactionRecovery(wallet, 'send', [5042002])).resolves.toMatchObject({
      claimed: false,
      error: new Error('quota'),
    });
    await expect(resolveUnsubmittedTransactionRecovery(wallet, 'send', ['send'], 'missing')).resolves.toMatchObject({
      message: expect.stringContaining('No transaction recovery record was found'),
    });
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
