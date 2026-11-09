import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hash } from 'viem';
import type { BridgeQuote } from '../../types/bridge';
import { createBridgeRecoveryJournalEntry, createRecoveredCctpBridgeQuote, readLatestBridgeRecoveryJournalEntry, saveBridgeRecoveryJournalEntry } from './recoveryJournal';

const walletAddress = '0x1111111111111111111111111111111111111111' as Address;
const sourceHash = `0x${'a'.repeat(64)}` as Hash;
const secondSourceHash = `0x${'b'.repeat(64)}` as Hash;
const quote: BridgeQuote = {
  id: 'quote-1',
  provider: 'Circle',
  fromChain: { id: 5042002, name: 'Arc Testnet' },
  toChain: { id: 11155111, name: 'Ethereum Sepolia' },
  fromToken: { chainId: 5042002, address: walletAddress, symbol: 'USDC', name: 'USDC', decimals: 6, isNative: false },
  toToken: { chainId: 11155111, address: walletAddress, symbol: 'USDC', name: 'USDC', decimals: 6, isNative: false },
  fromAmount: 1_000_000n,
  toAmount: 990_000n,
  toAmountMin: 980_000n,
  feeAmount: 10_000n,
  selectedRoute: 'cctp',
  gasAmount: null,
  gasCosts: [],
  executionDurationSeconds: null,
  transactionTarget: null,
  transactionData: null,
  transactionValue: 0n,
  bridge: 'Circle',
  quotedAt: 1,
  raw: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Bridge recovery journal', () => {
  it('saves recovery under a transaction-specific key without reading or locking prior records', () => {
    const setItem = vi.fn();
    const getItem = vi.fn(() => JSON.stringify({ status: 'pending', sourceHash }));
    const removeItem = vi.fn();
    vi.stubGlobal('window', {
      localStorage: { setItem, getItem, removeItem },
    });

    const first = createBridgeRecoveryJournalEntry(quote, walletAddress, sourceHash, 'error');
    const second = createBridgeRecoveryJournalEntry(quote, walletAddress, secondSourceHash, 'source-pending');

    expect(saveBridgeRecoveryJournalEntry(first)).toBeNull();
    expect(saveBridgeRecoveryJournalEntry(second)).toBeNull();
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(setItem.mock.calls[0][0]).toContain(`:${walletAddress}:${sourceHash}`);
    expect(setItem.mock.calls[1][0]).toContain(`:${walletAddress}:${secondSourceHash}`);
    expect(getItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('retains the source hash and route metadata in the saved recovery snapshot', () => {
    const setItem = vi.fn();
    vi.stubGlobal('window', { localStorage: { setItem } });
    const entry = createBridgeRecoveryJournalEntry(quote, walletAddress, sourceHash, 'error', {
      destinationHash: secondSourceHash,
      error: 'Attestation timed out.',
      updatedAt: 123,
    });

    expect(saveBridgeRecoveryJournalEntry(entry)).toBeNull();
    expect(JSON.parse(setItem.mock.calls[0][1])).toMatchObject({
      version: 2,
      walletAddress,
      route: 'cctp',
      sourceHash,
      recipientAddress: walletAddress,
      sourceTarget: expect.any(String),
      destinationHash: secondSourceHash,
      status: 'error',
      error: 'Attestation timed out.',
      updatedAt: 123,
    });
  });

  it('restores the latest validated CCTP quote for the saved wallet', () => {
    const entry = createBridgeRecoveryJournalEntry(quote, walletAddress, sourceHash, 'needs-attention', {
      updatedAt: 123,
    });
    const key = `orbit:bridge-recovery:v2:${walletAddress}:${sourceHash}`;
    const getItem = vi.fn(() => JSON.stringify({ version: 2, ...entry }));
    vi.stubGlobal('window', {
      localStorage: {
        length: 1,
        key: vi.fn(() => key),
        getItem,
        setItem: vi.fn(),
      },
    });

    const restored = readLatestBridgeRecoveryJournalEntry(walletAddress);
    const recoveredQuote = restored.entry && createRecoveredCctpBridgeQuote(restored.entry);

    expect(restored.error).toBeUndefined();
    expect(restored.entry?.sourceHash).toBe(sourceHash);
    expect(recoveredQuote).toMatchObject({
      fromChain: quote.fromChain,
      toChain: quote.toChain,
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
      recipientAddress: walletAddress,
      selectedRoute: 'cctp',
    });
    expect(recoveredQuote?.transactionTarget).not.toBeNull();
  });

  it('restores legacy journal entries by validating the wallet as the original recipient', () => {
    const legacyEntry = {
      ...createBridgeRecoveryJournalEntry(quote, walletAddress, sourceHash, 'needs-attention'),
      recipientAddress: undefined,
      sourceTarget: undefined,
    };
    const key = `orbit:bridge-recovery:v2:${walletAddress}:${sourceHash}`;
    vi.stubGlobal('window', {
      localStorage: {
        length: 1,
        key: () => key,
        getItem: () => JSON.stringify({ version: 2, ...legacyEntry }),
      },
    });

    const restored = readLatestBridgeRecoveryJournalEntry(walletAddress);
    const recoveredQuote = restored.entry && createRecoveredCctpBridgeQuote(restored.entry);

    expect(restored.entry).toMatchObject({ walletAddress, sourceHash });
    expect(recoveredQuote?.recipientAddress).toBe(walletAddress);
    expect(recoveredQuote?.transactionTarget).toBeTruthy();
  });
});
