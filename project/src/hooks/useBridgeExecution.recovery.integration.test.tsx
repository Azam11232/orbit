// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, pad, type Address, type Hash, type Hex } from 'viem';
import { getOrbitNetwork } from '../data/networks';
import { cctpMessageTransmitterAbi, cctpTokenMessengerAbi } from '../services/bridge/cctp';
import { createBridgeRecoveryJournalEntry, saveBridgeRecoveryJournalEntry } from '../services/bridge/recoveryJournal';
import type { BridgeQuote } from '../types/bridge';
import { useBridgeExecution } from './useBridgeExecution';

const bridgeMocks = vi.hoisted(() => ({
  wallet: '0x1111111111111111111111111111111111111111',
  sourceHash: `0x${'a'.repeat(64)}`,
  destinationHash: `0x${'b'.repeat(64)}`,
  wrongWallet: '0x2222222222222222222222222222222222222222',
  sourceClient: null as Record<string, unknown> | null,
  destinationClient: null as Record<string, unknown> | null,
  execution: null as Record<string, unknown> | null,
  sourceInput: '0x' as `0x${string}`,
  destinationInput: '0x' as `0x${string}`,
  getStatus: vi.fn(),
  sendTransaction: vi.fn(),
  verifyDestinationReceipt: vi.fn(() => true),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: bridgeMocks.wallet,
    chainId: 11155111,
    connector: undefined,
  }),
  usePublicClient: ({ chainId }: { chainId?: number }) =>
    chainId === 5042002 ? bridgeMocks.sourceClient : bridgeMocks.destinationClient,
  useSendTransaction: () => ({ sendTransactionAsync: bridgeMocks.sendTransaction }),
}));

vi.mock('../services/bridge/cctp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/bridge/cctp')>();
  return {
    ...actual,
    createCctpProvider: () => ({ getStatus: bridgeMocks.getStatus }),
    getCctpMessageIdentity: () => ({
      sourceDomain: 26,
      nonce: `0x${'0'.repeat(64)}`,
      sender: `0x${'0'.repeat(64)}`,
      messageBodyHash: `0x${'0'.repeat(64)}`,
    }),
  };
});

vi.mock('../services/bridge/verification', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/bridge/verification')>(),
  verifyDestinationReceipt: bridgeMocks.verifyDestinationReceipt,
}));

const walletAddress = bridgeMocks.wallet as Address;
const sourceHash = bridgeMocks.sourceHash as Hash;
const destinationHash = bridgeMocks.destinationHash as Hash;
const sourceNetwork = getOrbitNetwork(5042002)!;
const destinationNetwork = getOrbitNetwork(11155111)!;
const message = `0x${'00'.repeat(148)}` as Hex;
const attestation = '0x1234' as Hex;

const quote: BridgeQuote = {
  id: 'recovery-test-quote',
  provider: 'Circle CCTP V2',
  fromChain: { id: sourceNetwork.id, name: sourceNetwork.name },
  toChain: { id: destinationNetwork.id, name: destinationNetwork.name },
  fromToken: {
    chainId: sourceNetwork.id,
    address: sourceNetwork.usdc,
    symbol: 'USDC',
    name: 'Arc USDC',
    decimals: 6,
    isNative: false,
  },
  toToken: {
    chainId: destinationNetwork.id,
    address: destinationNetwork.usdc,
    symbol: 'USDC',
    name: 'Sepolia USDC',
    decimals: 6,
    isNative: false,
  },
  recipientAddress: walletAddress,
  fromAmount: 1_000_000n,
  toAmount: 1_000_000n,
  toAmountMin: 1_000_000n,
  feeAmount: 0n,
  feePayment: 'source',
  selectedRoute: 'cctp',
  gasAmount: null,
  gasCosts: [],
  executionDurationSeconds: null,
  transactionTarget: sourceNetwork.tokenMessengerV2,
  transactionData: null,
  transactionValue: 0n,
  bridge: 'Circle CCTP V2',
  quotedAt: Date.now(),
  raw: null,
};

function sourceBurnInput(overrides: {
  amount?: bigint;
  destinationDomain?: number;
  mintRecipient?: Hex;
  burnToken?: Address;
  destinationCaller?: Hex;
  maxFee?: bigint;
  minFinalityThreshold?: number;
} = {}) {
  return encodeFunctionData({
    abi: cctpTokenMessengerAbi,
    functionName: 'depositForBurn',
    args: [
      overrides.amount ?? quote.fromAmount,
      overrides.destinationDomain ?? destinationNetwork.cctpDomain,
      overrides.mintRecipient ?? pad(walletAddress, { size: 32 }),
      overrides.burnToken ?? sourceNetwork.usdc,
      overrides.destinationCaller ?? `0x${'0'.repeat(64)}`,
      overrides.maxFee ?? 0n,
      overrides.minFinalityThreshold ?? 2000,
    ],
  });
}

function saveRecovery(
  destinationHashValue?: Hash,
  destinationSubmissionState?: 'not-submitted' | 'submission-pending' | 'submitted' | 'confirmed' | 'submission-unknown',
) {
  const entry = createBridgeRecoveryJournalEntry(quote, walletAddress, sourceHash, 'needs-attention', {
    ...(destinationHashValue ? { destinationHash: destinationHashValue } : {}),
    ...(destinationSubmissionState ? { destinationSubmissionState } : {}),
  });
  expect(saveBridgeRecoveryJournalEntry(entry)).toBeNull();
}

function StateProbe() {
  const execution = useBridgeExecution(undefined);
  bridgeMocks.execution = execution as unknown as Record<string, unknown>;
  return createElement('output', {
    'data-status': execution.status,
    'data-source-hash': execution.sourceHash ?? '',
    'data-destination-hash': execution.destinationHash ?? '',
    'data-destination-submission-state': execution.destinationSubmissionState,
    'data-source-receipt-confirmed': String(execution.sourceReceiptConfirmed),
    'data-destination-verified': String(execution.destinationVerified),
  });
}

describe('CCTP Bridge recovery integration', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    bridgeMocks.sourceInput = sourceBurnInput();
    bridgeMocks.destinationInput = encodeFunctionData({
      abi: cctpMessageTransmitterAbi,
      functionName: 'receiveMessage',
      args: [message, attestation],
    });
    bridgeMocks.getStatus.mockReset();
    bridgeMocks.getStatus.mockResolvedValue({
      status: 'DONE',
      message,
      attestation,
    });
    bridgeMocks.verifyDestinationReceipt.mockReset();
    bridgeMocks.verifyDestinationReceipt.mockReturnValue(true);
    bridgeMocks.sendTransaction.mockReset();
    bridgeMocks.sendTransaction.mockImplementation(async ({ data }: { data: Hex }) => {
      bridgeMocks.destinationInput = data;
      return destinationHash;
    });
    bridgeMocks.sourceClient = {
      getChainId: vi.fn(async () => sourceNetwork.id),
      getTransaction: vi.fn(async () => ({
        hash: sourceHash,
        from: walletAddress,
        to: sourceNetwork.tokenMessengerV2,
        input: bridgeMocks.sourceInput,
      })),
      getTransactionReceipt: vi.fn(async () => ({
        transactionHash: sourceHash,
        status: 'success',
        to: sourceNetwork.tokenMessengerV2,
      })),
    };
    bridgeMocks.destinationClient = {
      getChainId: vi.fn(async () => destinationNetwork.id),
      estimateGas: vi.fn(async () => 100n),
      getGasPrice: vi.fn(async () => 1n),
      getBalance: vi.fn(async () => 1_000n),
      getTransaction: vi.fn(async () => ({
        hash: destinationHash,
        from: walletAddress,
        to: destinationNetwork.messageTransmitterV2,
        input: bridgeMocks.destinationInput,
      })),
      getTransactionReceipt: vi.fn(async () => ({
        transactionHash: destinationHash,
        status: 'success',
        to: destinationNetwork.messageTransmitterV2,
        logs: [],
      })),
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderAndFlush() {
    await act(async () => {
      root.render(createElement(StateProbe));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  }

  async function flush() {
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  }

  it('restores after remount, retries a failed receipt lookup, resumes pending attestation, and completes the mint', async () => {
    saveRecovery();
    const sourceClient = bridgeMocks.sourceClient!;
    const receiptLookup = sourceClient.getTransactionReceipt as ReturnType<typeof vi.fn>;
    receiptLookup.mockRejectedValueOnce(new Error('Receipt RPC unavailable'));
    await renderAndFlush();
    await flush();

    expect(host.querySelector('output')?.getAttribute('data-source-hash')).toBe(sourceHash);
    expect(host.querySelector('output')?.getAttribute('data-source-receipt-confirmed')).toBe('false');
    expect(bridgeMocks.sendTransaction).not.toHaveBeenCalled();

    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpSourceReceipt: () => Promise<void> }).retryCctpSourceReceipt();
    });
    expect(host.querySelector('output')?.getAttribute('data-source-receipt-confirmed')).toBe('true');
    expect(bridgeMocks.sendTransaction).not.toHaveBeenCalled();

    vi.useFakeTimers();
    bridgeMocks.getStatus.mockResolvedValue({ status: 'PENDING' });
    await act(async () => {
      const retry = (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
      await vi.runAllTimersAsync();
      await retry;
    });
    expect(bridgeMocks.getStatus).toHaveBeenCalledTimes(20);
    expect(host.querySelector('output')?.getAttribute('data-source-hash')).toBe(sourceHash);
    expect(host.querySelector('output')?.getAttribute('data-status')).toBe('needs-attention');
    expect(bridgeMocks.sendTransaction).not.toHaveBeenCalled();

    bridgeMocks.getStatus.mockResolvedValue({ status: 'DONE', message, attestation });
    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
    });
    expect(host.querySelector('output')?.getAttribute('data-status')).toBe('attestation-ready');

    await act(async () => {
      await (bridgeMocks.execution as unknown as { complete: (message: Hex, attestation: Hex) => Promise<void> }).complete(message, attestation);
    });
    expect(host.querySelector('output')?.getAttribute('data-status')).toBe('completed');
    expect(host.querySelector('output')?.getAttribute('data-destination-verified')).toBe('true');
    expect(bridgeMocks.sendTransaction).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({
      to: destinationNetwork.messageTransmitterV2,
      data: bridgeMocks.destinationInput,
    }));
  });

  it('verifies a saved destination transaction after remount without submitting another mint', async () => {
    saveRecovery(destinationHash);
    await renderAndFlush();
    await flush();
    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
    });
    await act(async () => {
      await (bridgeMocks.execution as unknown as { complete: (message: Hex, attestation: Hex) => Promise<void> }).complete(message, attestation);
    });

    expect(host.querySelector('output')?.getAttribute('data-status')).toBe('completed');
    expect(host.querySelector('output')?.getAttribute('data-destination-verified')).toBe('true');
    expect(bridgeMocks.sendTransaction).not.toHaveBeenCalled();
    expect(bridgeMocks.destinationClient?.getTransaction).toHaveBeenCalledWith({ hash: destinationHash });
  });

  it('rejects a saved source transaction from another wallet before attestation can resume', async () => {
    saveRecovery();
    const sourceClient = bridgeMocks.sourceClient!;
    (sourceClient.getTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      hash: sourceHash,
      from: bridgeMocks.wrongWallet,
      to: sourceNetwork.tokenMessengerV2,
      input: bridgeMocks.sourceInput,
    });
    await renderAndFlush();
    await flush();

    expect(host.querySelector('output')?.getAttribute('data-source-receipt-confirmed')).toBe('false');
    expect(bridgeMocks.sendTransaction).not.toHaveBeenCalled();
    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
    });
    expect(bridgeMocks.getStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['amount', { amount: quote.fromAmount + 1n }],
    ['destination domain', { destinationDomain: destinationNetwork.cctpDomain + 1 }],
    ['mint recipient', { mintRecipient: `0x${'0'.repeat(63)}2` as Hex }],
    ['burn token', { burnToken: walletAddress }],
    ['destination caller', { destinationCaller: `0x${'0'.repeat(63)}1` as Hex }],
    ['max fee', { maxFee: 1n }],
    ['minimum finality threshold', { minFinalityThreshold: 2001 }],
  ])('rejects saved source burn calldata with a mismatched %s', async (_field, overrides) => {
    saveRecovery();
    const sourceClient = bridgeMocks.sourceClient!;
    (sourceClient.getTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      hash: sourceHash,
      from: walletAddress,
      to: sourceNetwork.tokenMessengerV2,
      input: sourceBurnInput(overrides),
    });

    await renderAndFlush();
    await flush();

    expect(host.querySelector('output')?.getAttribute('data-source-receipt-confirmed')).toBe('false');
    expect(bridgeMocks.getStatus).not.toHaveBeenCalled();
    expect(bridgeMocks.sendTransaction).not.toHaveBeenCalled();
  });

  it('allows another mint only after an explicit wallet rejection', async () => {
    saveRecovery();
    await renderAndFlush();
    await flush();
    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
    });
    bridgeMocks.sendTransaction
      .mockRejectedValueOnce({ code: 4001, message: 'User rejected request' })
      .mockResolvedValueOnce(destinationHash);

    let rejection: unknown;
    await act(async () => {
      try {
        await (bridgeMocks.execution as unknown as { complete: (message: Hex, attestation: Hex) => Promise<void> }).complete(message, attestation);
      } catch (caughtError) {
        rejection = caughtError;
      }
    });
    expect(rejection).toBeInstanceOf(Error);
    expect(host.querySelector('output')?.getAttribute('data-destination-submission-state')).toBe('not-submitted');
    expect(JSON.parse(window.localStorage.getItem(`orbit:bridge-recovery:v2:${walletAddress}:${sourceHash}`) ?? '{}'))
      .toMatchObject({ destinationSubmissionState: 'not-submitted' });

    await act(async () => {
      await (bridgeMocks.execution as unknown as { complete: (message: Hex, attestation: Hex) => Promise<void> }).complete(message, attestation);
    });
    expect(bridgeMocks.sendTransaction).toHaveBeenCalledTimes(2);
    expect(host.querySelector('output')?.getAttribute('data-destination-submission-state')).toBe('confirmed');
  });

  it('marks an ambiguous wallet response unknown and prevents every later mint submission', async () => {
    saveRecovery();
    await renderAndFlush();
    await flush();
    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
    });
    bridgeMocks.sendTransaction.mockRejectedValueOnce(new Error('Wallet transport disconnected after broadcast'));

    let submissionError: unknown;
    await act(async () => {
      try {
        await (bridgeMocks.execution as unknown as { complete: (message: Hex, attestation: Hex) => Promise<void> }).complete(message, attestation);
      } catch (caughtError) {
        submissionError = caughtError;
      }
    });
    expect(submissionError).toBeInstanceOf(Error);
    expect((submissionError as Error).message).toContain('Wallet transport disconnected after broadcast');
    expect(host.querySelector('output')?.getAttribute('data-destination-submission-state')).toBe('submission-unknown');
    expect(JSON.parse(window.localStorage.getItem(`orbit:bridge-recovery:v2:${walletAddress}:${sourceHash}`) ?? '{}'))
      .toMatchObject({ destinationSubmissionState: 'submission-unknown' });
    let duplicateError: unknown;
    await act(async () => {
      try {
        await (bridgeMocks.execution as unknown as { complete: (message: Hex, attestation: Hex) => Promise<void> }).complete(message, attestation);
      } catch (caughtError) {
        duplicateError = caughtError;
      }
    });
    expect((duplicateError as Error).message).toContain('will not submit another mint');
    expect(bridgeMocks.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('restores an in-flight wallet submission as unknown and does not resubmit after reload', async () => {
    saveRecovery();
    await renderAndFlush();
    await flush();
    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
    });

    let resolveWalletSubmission!: (hash: Hash) => void;
    const walletSubmission = new Promise<Hash>((resolve) => {
      resolveWalletSubmission = resolve;
    });
    bridgeMocks.sendTransaction.mockImplementationOnce(() => walletSubmission);
    let inFlightMint!: Promise<void>;
    await act(async () => {
      inFlightMint = (bridgeMocks.execution as unknown as {
        complete: (message: Hex, attestation: Hex) => Promise<void>;
      }).complete(message, attestation);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(bridgeMocks.sendTransaction).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem(`orbit:bridge-recovery:v2:${walletAddress}:${sourceHash}`) ?? '{}'))
      .toMatchObject({ destinationSubmissionState: 'submission-pending' });
    let concurrentError: unknown;
    await act(async () => {
      try {
        await (bridgeMocks.execution as unknown as {
          complete: (message: Hex, attestation: Hex) => Promise<void>;
        }).complete(message, attestation);
      } catch (caughtError) {
        concurrentError = caughtError;
      }
    });
    expect((concurrentError as Error).message).toContain('will not submit another mint');
    expect(bridgeMocks.sendTransaction).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    host.replaceChildren();
    root = createRoot(host);
    await renderAndFlush();
    await flush();
    expect(host.querySelector('output')?.getAttribute('data-destination-submission-state')).toBe('submission-unknown');
    expect(JSON.parse(window.localStorage.getItem(`orbit:bridge-recovery:v2:${walletAddress}:${sourceHash}`) ?? '{}'))
      .toMatchObject({ destinationSubmissionState: 'submission-unknown' });

    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
    });
    let duplicateError: unknown;
    await act(async () => {
      try {
        await (bridgeMocks.execution as unknown as { complete: (message: Hex, attestation: Hex) => Promise<void> }).complete(message, attestation);
      } catch (caughtError) {
        duplicateError = caughtError;
      }
    });
    expect((duplicateError as Error).message).toContain('will not submit another mint');
    expect(bridgeMocks.sendTransaction).toHaveBeenCalledTimes(1);

    resolveWalletSubmission(destinationHash);
    await act(async () => {
      await inFlightMint;
    });
  });

  it('treats a legacy errored recovery without a destination hash as ambiguous', async () => {
    saveRecovery();
    const key = `orbit:bridge-recovery:v2:${walletAddress}:${sourceHash}`;
    const legacy = JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    legacy.status = 'error';
    delete legacy.destinationSubmissionState;
    window.localStorage.setItem(key, JSON.stringify(legacy));

    await renderAndFlush();
    await flush();
    expect(host.querySelector('output')?.getAttribute('data-destination-submission-state')).toBe('submission-unknown');

    await act(async () => {
      await (bridgeMocks.execution as unknown as { retryCctpAttestation: () => Promise<void> }).retryCctpAttestation();
    });
    let recoveryError: unknown;
    await act(async () => {
      try {
        await (bridgeMocks.execution as unknown as {
          complete: (message: Hex, attestation: Hex) => Promise<void>;
        }).complete(message, attestation);
      } catch (caughtError) {
        recoveryError = caughtError;
      }
    });
    expect((recoveryError as Error).message).toContain('will not submit another mint');
    expect(bridgeMocks.sendTransaction).not.toHaveBeenCalled();
  });
});
