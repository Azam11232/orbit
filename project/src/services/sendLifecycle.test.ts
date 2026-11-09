import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { claimTransactionRecovery, readTransactionRecovery, resetTransactionRecoveryCacheForTests, resolveTerminalTransactionRecovery, updateTransactionRecovery } from './transactionRecovery';
import { createFreshSendFormState, isCurrentSendFlow, shouldShowSendSuccess } from './sendLifecycle';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const hash = `0x${'a'.repeat(64)}` as const;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

beforeEach(() => {
  resetTransactionRecoveryCacheForTests();
  vi.stubGlobal('window', { localStorage: memoryStorage(), sessionStorage: memoryStorage() });
  vi.stubGlobal('navigator', {
    locks: {
      request: vi.fn(async (_name: string, callback: () => unknown) => callback()),
    },
  });
});

describe('Send success lifecycle', () => {
  it.each(['close', 'Send Again'])('%s starts a clean form without implying transaction cancellation', async () => {
    const claim = await claimTransactionRecovery(wallet, 'send', [5042002]);
    expect(claim.claimed).toBe(true);

    const fresh = createFreshSendFormState();

    expect(fresh).toEqual({
      recipient: '',
      amount: '',
      formError: null,
      completedAt: null,
      showReview: false,
    });
    expect(readTransactionRecovery(wallet, 'send').record).toMatchObject({
      status: 'wallet-request',
      transactions: [],
    });
  });

  it('renders only the success view for a complete confirmed result', () => {
    expect(shouldShowSendSuccess({ status: 'confirmed', transactionHash: hash })).toBe(true);
    expect(shouldShowSendSuccess({ status: 'confirmed' })).toBe(false);
    expect(shouldShowSendSuccess({ status: 'pending', transactionHash: hash })).toBe(false);
  });

  it('does not apply an async result from a previous Send flow after the UI transitions', () => {
    const oldFlowGeneration = 4;
    const currentFlowGeneration = 5;

    expect(isCurrentSendFlow(oldFlowGeneration, currentFlowGeneration)).toBe(false);
    expect(isCurrentSendFlow(currentFlowGeneration, currentFlowGeneration)).toBe(true);
  });

  it('retains the submitted hash when dismissing a confirmed result', async () => {
    await claimTransactionRecovery(wallet, 'send', [5042002]);
    updateTransactionRecovery(wallet, 'send', {
      status: 'confirmed',
      transactions: [{ chainId: 5042002, hash, step: 'send' }],
    });

    await expect(resolveTerminalTransactionRecovery(wallet, ['send'])).resolves.toMatchObject({
      message: expect.stringContaining('contains a transaction hash'),
    });
    expect(readTransactionRecovery(wallet, 'send').record).toMatchObject({
      status: 'confirmed',
      transactions: [{ hash, step: 'send' }],
    });
  });
});
