// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArcSwapReceiptAccountingGenerationIdentity } from '../services/swap/receiptAccountingRetry';
import type { ArcSwapReceiptAccounting } from '../services/swap/receiptAccounting';
import { ArcSwapPage } from './ArcSwapPage';

const pageMocks = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111',
  walletA: '0x1111111111111111111111111111111111111111',
  walletB: '0x2222222222222222222222222222222222222222',
  hash: `0x${'a'.repeat(64)}` as `0x${string}`,
  execution: null as Record<string, unknown> | null,
  onConfirmed: null as ((identity: ArcSwapReceiptAccountingGenerationIdentity, isCurrent: () => boolean) => void | Promise<void>) | null,
  persistSuccess: vi.fn((): Error | null => null),
  refetchInput: vi.fn(async () => ({ isError: false })),
  refetchOutput: vi.fn(async () => ({ isError: false })),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: pageMocks.address,
    chainId: 5042002,
    connector: undefined,
    isConnected: true,
  }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), removeQueries: vi.fn() }),
}));

vi.mock('../hooks/useTokenBalance', () => ({
  useTokenBalance: () => ({
    raw: 100000000n,
    isError: false,
    isLoading: false,
    isFetching: false,
    refetch: pageMocks.refetchInput,
  }),
}));

vi.mock('../hooks/useArcSwap', () => ({
  useArcSwapQuote: () => ({
    quote: undefined,
    dataUpdatedAt: 0,
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: false,
    error: null,
    refetch: vi.fn(),
    queryKey: [],
  }),
  useArcSwapExecution: (onConfirmed: typeof pageMocks.onConfirmed) => {
    pageMocks.onConfirmed = onConfirmed;
    return pageMocks.execution;
  },
}));

vi.mock('../services/swap/successLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/swap/successLifecycle')>();
  return {
    ...actual,
    persistArcSwapSuccessSummary: pageMocks.persistSuccess,
    readArcSwapSuccess: () => ({ record: null, error: null }),
  };
});

vi.mock('./TransactionSuccessScreen', () => ({
  TransactionSuccessScreen: ({ description }: { description?: ReactNode }) =>
    createElement('div', { 'data-testid': 'arc-swap-success' }, description),
}));

vi.mock('./SlideToConfirm', () => ({
  SlideToConfirm: () => createElement('div'),
}));

vi.mock('./ui', () => {
  const Component = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Button: Component,
    Card: Component,
    Label: Component,
    TokenIcon: () => createElement('span'),
  };
});

const accounting: ArcSwapReceiptAccounting = {
  amountSold: '1.00',
  amountReceived: '0.99',
  inputToken: 'USDC',
  outputToken: 'EURC',
  completedAt: 123,
  minimumReceived: '0.98',
  providerFee: null,
  gasPaid: null,
  usdcBalanceBefore: null,
  usdcBalanceAfter: null,
  netUsdcBalanceChange: null,
};

function makeExecution(
  identity: ArcSwapReceiptAccountingGenerationIdentity | null,
  currentGeneration: number | null,
  receiptAccounting: ArcSwapReceiptAccounting | null,
) {
  return {
    execute: vi.fn(),
    reset: vi.fn(),
    retryRecoveryCheck: vi.fn(),
    retryReceiptAccounting: vi.fn(),
    state: 'confirmed',
    transactionHash: pageMocks.hash,
    recovered: false,
    error: null,
    receiptAccounting,
    receiptAccountingIdentity: identity,
    receiptAccountingCurrentGeneration: currentGeneration,
    receiptAccountingError: null,
    receiptAccountingLoading: false,
    receiptStatusVerified: true,
  };
}

describe('ArcSwapPage receipt accounting generation integration', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    pageMocks.address = pageMocks.walletA;
    pageMocks.execution = makeExecution(
      { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 1 },
      1,
      null,
    );
    pageMocks.onConfirmed = null;
    pageMocks.persistSuccess.mockClear();
    pageMocks.refetchInput.mockClear();
    pageMocks.refetchOutput.mockClear();
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
      root.render(createElement(ArcSwapPage));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('rejects the original A result after an A to B to A wallet transition', async () => {
    await renderAndFlush();
    expect(pageMocks.persistSuccess).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="arc-swap-success"]')).toBeNull();

    pageMocks.address = pageMocks.walletB;
    pageMocks.execution = makeExecution(
      { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 1 },
      2,
      accounting,
    );
    await renderAndFlush();
    expect(pageMocks.persistSuccess).not.toHaveBeenCalled();

    pageMocks.address = pageMocks.walletA;
    pageMocks.execution = makeExecution(
      { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 1 },
      3,
      accounting,
    );
    await renderAndFlush();
    expect(pageMocks.persistSuccess).not.toHaveBeenCalled();

    pageMocks.execution = makeExecution(
      { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 3 },
      3,
      accounting,
    );
    await renderAndFlush();

    expect(pageMocks.persistSuccess).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="arc-swap-success"]')).not.toBeNull();
    for (let render = 0; render < 3; render += 1) await renderAndFlush();
    expect(pageMocks.persistSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows success and persists accounting for the current generation', async () => {
    pageMocks.execution = makeExecution(
      { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 7 },
      7,
      accounting,
    );

    await renderAndFlush();

    expect(host.querySelector('[data-testid="arc-swap-success"]')).not.toBeNull();
    expect(pageMocks.persistSuccess).toHaveBeenCalledTimes(1);
  });

  it('persists the same successful account and transaction only once across rerenders', async () => {
    pageMocks.execution = makeExecution(
      { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 7 },
      7,
      accounting,
    );

    await renderAndFlush();
    for (let render = 0; render < 5; render += 1) {
      pageMocks.execution = makeExecution(
        { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 7 },
        7,
        { ...accounting },
      );
      await renderAndFlush();
    }

    expect(pageMocks.persistSuccess).toHaveBeenCalledTimes(1);
    expect(pageMocks.persistSuccess).toHaveBeenCalledWith(
      pageMocks.walletA,
      pageMocks.hash,
      expect.objectContaining({ amountSold: accounting.amountSold, amountReceived: accounting.amountReceived }),
    );
  });

  it('does not refresh balances for a stale acknowledgement', async () => {
    await renderAndFlush();
    expect(pageMocks.onConfirmed).toBeTypeOf('function');

    await act(async () => {
      await pageMocks.onConfirmed?.(
        { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 1 },
        () => false,
      );
    });

    expect(pageMocks.refetchInput).not.toHaveBeenCalled();
    expect(pageMocks.refetchOutput).not.toHaveBeenCalled();
  });

  it('retries a failed success-summary write and never repeats a successful write', async () => {
    pageMocks.execution = makeExecution(
      { walletAddress: pageMocks.walletA, transactionHash: pageMocks.hash, generation: 7 },
      7,
      accounting,
    );
    pageMocks.persistSuccess
      .mockReturnValueOnce(new Error('Storage unavailable'))
      .mockReturnValueOnce(null);

    await renderAndFlush();
    expect(pageMocks.persistSuccess).toHaveBeenCalledTimes(1);

    const retryButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Retry saving verified swap details'));
    expect(retryButton).toBeDefined();
    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(pageMocks.persistSuccess).toHaveBeenCalledTimes(2);

    for (let render = 0; render < 3; render += 1) await renderAndFlush();
    expect(pageMocks.persistSuccess).toHaveBeenCalledTimes(2);
  });
});
