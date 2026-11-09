// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { useArcSwapExecution } from './useArcSwap';

const mocks = vi.hoisted(() => {
  const hashA = `0x${'a'.repeat(64)}`;
  const hashB = `0x${'b'.repeat(64)}`;
  const walletA = '0x1111111111111111111111111111111111111111';
  const walletB = '0x2222222222222222222222222222222222222222';
  return {
    address: walletA,
    walletA,
    walletB,
    hashA,
    hashB,
    getTransaction: vi.fn(async ({ hash }: { hash: string }) => ({
      hash,
      from: walletA,
      to: walletB,
      input: '0x',
      gasPrice: 1n,
    })),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => ({
      transactionHash: hash,
      status: 'success',
      blockNumber: 1n,
      gasUsed: 1n,
      effectiveGasPrice: 1n,
      logs: [],
    })),
    getBlock: vi.fn(async () => ({ timestamp: 1n })),
    publicClient: null as unknown as PublicClient,
    accountReceipt: vi.fn((_transaction: unknown, _receipt: unknown, walletAddress: string) => ({
      amountSold: '1',
      amountReceived: walletAddress,
      inputToken: 'USDC',
      outputToken: 'EURC',
      completedAt: 1,
      minimumReceived: '0',
      providerFee: null,
      gasPaid: null,
      usdcBalanceBefore: null,
      usdcBalanceAfter: null,
      netUsdcBalanceChange: null,
    })),
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mocks.address, chainId: 5042002 }),
  usePublicClient: () => mocks.publicClient,
}));

vi.mock('../services/transactionRecovery', () => ({
  claimTransactionRecovery: vi.fn(),
  inspectKnownTransactionReceipt: vi.fn(),
  isRecoveryUnresolved: vi.fn(() => false),
  readTransactionRecovery: vi.fn((address: string) => ({
    error: null,
    record: {
      status: 'confirmed',
      operationId: `operation-${address}`,
      transactions: [{
        hash: address.toLowerCase() === mocks.walletA.toLowerCase() ? mocks.hashA : mocks.hashB,
        step: 'swap',
      }],
    },
  })),
  resolveRecoveryContext: vi.fn((record: unknown) => ({ type: 'match', record })),
  resolveUnsubmittedTransactionRecovery: vi.fn(),
  updateTransactionRecovery: vi.fn(),
  updateTransactionRecoveryIfCurrent: vi.fn(),
}));

vi.mock('../services/swap/receiptAccounting', () => ({
  accountArcSwapReceipt: mocks.accountReceipt,
}));

describe('useArcSwap receipt accounting generation integration', () => {
  let host: HTMLDivElement;
  let root: Root;
  const renderObservations: Array<{ wallet: string; amount: string | null }> = [];
  let latestExecution: ReturnType<typeof useArcSwapExecution> | undefined;

  function HookConsumer() {
    const execution = useArcSwapExecution();
    latestExecution = execution;
    renderObservations.push({
      wallet: mocks.address,
      amount: execution.receiptAccounting?.amountReceived ?? null,
    });
    return createElement('output', null, execution.receiptAccounting?.amountReceived ?? 'unverified');
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.address = mocks.walletA;
    mocks.publicClient = {
      getTransaction: mocks.getTransaction,
      getTransactionReceipt: mocks.getTransactionReceipt,
      getBlock: mocks.getBlock,
    } as unknown as PublicClient;
    mocks.getTransaction.mockClear();
    mocks.getTransactionReceipt.mockClear();
    mocks.getBlock.mockClear();
    mocks.accountReceipt.mockClear();
    renderObservations.length = 0;
    latestExecution = undefined;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function renderAndFlush() {
    await act(async () => {
      root.render(createElement(HookConsumer));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function waitForAccounting() {
    for (let attempt = 0; attempt < 20 && !latestExecution?.receiptAccounting; attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    expect(latestExecution?.receiptAccounting).toBeTruthy();
  }

  it('does not expose Wallet A receipt accounting in the first Wallet B render', async () => {
    await renderAndFlush();
    await waitForAccounting();
    expect(latestExecution?.receiptAccounting?.amountReceived).toBe(mocks.walletA);

    mocks.address = mocks.walletB;
    await renderAndFlush();

    const firstWalletBRender = renderObservations.find((observation) => observation.wallet === mocks.walletB);
    expect(firstWalletBRender).toEqual({ wallet: mocks.walletB, amount: null });
  });
});
