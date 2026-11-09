import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hash, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ARBITRUM_SEPOLIA, AVALANCHE_FUJI, getOrbitNetwork } from '../../data/networks';
import { createBridgeExecutionGate } from './lifecycle';
import { BridgeTrackingTimeoutError, reconcileForwardingTransfer, type ForwardingReconciliationAdapter } from './forwardingReconciliation';
import { verifyForwardingDestinationReceipt } from './verification';

const sourceHash = `0x${'a'.repeat(64)}` as Hash;
const destinationHash = `0x${'b'.repeat(64)}` as Hash;
const sourceAddress = '0x1111111111111111111111111111111111111111' as Address;
const recipient = '0x2222222222222222222222222222222222222222' as Address;
const receivedAmount = 4_000_000n;

function destinationTransferLog(token: Address) {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: sourceAddress, to: recipient },
    }) as readonly Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [receivedAmount]),
    logIndex: 0,
  };
}

function adapterFor(token: Address, overrides: Partial<ForwardingReconciliationAdapter> = {}): ForwardingReconciliationAdapter {
  return {
    verifySourceReceipt: vi.fn(async () => true),
    pollStatus: vi.fn(async () => ({ forwardState: 'COMPLETE', forwardTxHash: destinationHash })),
    verifyDestinationReceipt: vi.fn(async () => verifyForwardingDestinationReceipt({
      receiptStatus: 'success',
      expectedToken: token,
      recipient,
      expectedAmount: receivedAmount,
      logs: [destinationTransferLog(token)],
    })),
    waitBeforeNextPoll: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Circle forwarding reconciliation', () => {
  it.each([
    ['Arbitrum Sepolia', ARBITRUM_SEPOLIA],
    ['Avalanche Fuji', AVALANCHE_FUJI],
  ])(
    'completes an incomplete forwarding result after verifying the destination USDC receipt on %s',
    async (_name, network) => {
      const token = getOrbitNetwork(network.id)!.usdc;
      const adapter = adapterFor(token, {
        pollStatus: vi.fn(async () => ({
          forwardState: 'COMPLETE',
          forwardTxHash: destinationHash,
        })),
      });

      await expect(reconcileForwardingTransfer(sourceHash, adapter))
        .resolves.toEqual({ sourceHash, destinationHash });
      expect(adapter.verifySourceReceipt).toHaveBeenCalledTimes(1);
      expect(adapter.pollStatus).toHaveBeenCalledTimes(1);
      expect(adapter.verifyDestinationReceipt).toHaveBeenCalledWith(destinationHash);
    },
  );

  it('keeps polling after Circle reports completion until the destination receipt is verifiable', async () => {
    const adapter = adapterFor(getOrbitNetwork(ARBITRUM_SEPOLIA.id)!.usdc, {
      verifyDestinationReceipt: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });

    await expect(reconcileForwardingTransfer(sourceHash, adapter))
      .resolves.toEqual({ sourceHash, destinationHash });
    expect(adapter.verifyDestinationReceipt).toHaveBeenCalledTimes(2);
    expect(adapter.waitBeforeNextPoll).toHaveBeenCalledTimes(1);
    expect(adapter.verifySourceReceipt).toHaveBeenCalledTimes(1);
  });

  it('completes from a verified destination hash while the initial forwarding status is still pending', async () => {
    const observedDestinationHash = vi.fn();
    const adapter = adapterFor(getOrbitNetwork(ARBITRUM_SEPOLIA.id)!.usdc, {
      pollStatus: vi.fn(async () => ({
        forwardState: 'PENDING',
        forwardTxHash: destinationHash,
      })),
    });

    await expect(reconcileForwardingTransfer(sourceHash, adapter, {
      onDestinationHash: observedDestinationHash,
    })).resolves.toEqual({ sourceHash, destinationHash });
    expect(observedDestinationHash).toHaveBeenCalledWith(destinationHash);
    expect(adapter.verifyDestinationReceipt).toHaveBeenCalledWith(destinationHash);
    expect(adapter.pollStatus).toHaveBeenCalledTimes(1);
  });

  it('completes when the destination hash arrives after attestation while Circle still reports pending', async () => {
    let now = 0;
    const adapter = adapterFor(getOrbitNetwork(ARBITRUM_SEPOLIA.id)!.usdc, {
      pollStatus: vi.fn()
        .mockResolvedValueOnce({ forwardState: 'PENDING' })
        .mockResolvedValueOnce({ forwardState: 'PENDING', forwardTxHash: destinationHash }),
      waitBeforeNextPoll: vi.fn(async () => { now += 3_000; }),
    });

    await expect(reconcileForwardingTransfer(sourceHash, adapter, {
      pollingWindowMs: 30_000,
      now: () => now,
    })).resolves.toEqual({ sourceHash, destinationHash });
    expect(adapter.pollStatus).toHaveBeenCalledTimes(2);
    expect(adapter.verifyDestinationReceipt).toHaveBeenCalledWith(destinationHash);
  });

  it('can verify a transfer after more than 20 checks within the polling window', async () => {
    let now = 0;
    let checks = 0;
    const adapter = adapterFor(getOrbitNetwork(ARBITRUM_SEPOLIA.id)!.usdc, {
      pollStatus: vi.fn(async () => {
        checks += 1;
        return checks < 25
          ? { forwardState: 'PENDING' }
          : { forwardState: 'COMPLETE', forwardTxHash: destinationHash };
      }),
      waitBeforeNextPoll: vi.fn(async () => { now += 3_000; }),
    });

    await expect(reconcileForwardingTransfer(sourceHash, adapter, {
      pollingWindowMs: 120_000,
      now: () => now,
    })).resolves.toEqual({ sourceHash, destinationHash });
    expect(adapter.pollStatus).toHaveBeenCalledTimes(25);
  });

  it('keeps the original source submission locked while recovery polls', async () => {
    const gate = createBridgeExecutionGate();
    const submitSource = vi.fn(async () => sourceHash);
    expect(gate.begin()).toBe(true);
    gate.markSourceSubmitted();
    await submitSource();
    gate.finish();

    const adapter = adapterFor(getOrbitNetwork(ARBITRUM_SEPOLIA.id)!.usdc, {
      pollStatus: vi.fn(async () => ({ forwardState: 'COMPLETE', forwardTxHash: destinationHash })),
    });
    await reconcileForwardingTransfer(sourceHash, adapter);

    expect(gate.begin()).toBe(false);
    expect(submitSource).toHaveBeenCalledTimes(1);
  });

  it('accepts a verified BridgeKit destination hash even when Circle status is incomplete', async () => {
    const adapter = adapterFor(getOrbitNetwork(ARBITRUM_SEPOLIA.id)!.usdc, {
      pollStatus: vi.fn(async () => ({ forwardState: 'PENDING' })),
    });

    await expect(reconcileForwardingTransfer(sourceHash, adapter, { pollingWindowMs: 2, destinationHashHint: destinationHash }))
      .resolves.toEqual({ sourceHash, destinationHash });
    expect(adapter.verifyDestinationReceipt).toHaveBeenCalledTimes(1);
    expect(adapter.pollStatus).not.toHaveBeenCalled();
  });

  it('reports an explicit Circle forwarding failure and never resubmits the source', async () => {
    const adapter = adapterFor(getOrbitNetwork(ARBITRUM_SEPOLIA.id)!.usdc, {
      pollStatus: vi.fn(async () => ({
        forwardState: 'FAILED',
        forwardErrorDetails: 'Circle relay failed',
      })),
    });

    await expect(reconcileForwardingTransfer(sourceHash, adapter)).rejects.toThrow('Circle relay failed');
    expect(adapter.verifySourceReceipt).toHaveBeenCalledTimes(1);
    expect(adapter.pollStatus).toHaveBeenCalledTimes(1);
    expect(adapter.verifyDestinationReceipt).not.toHaveBeenCalled();
  });

  it('returns an unverified timeout instead of claiming failure when status cannot be confirmed', async () => {
    let now = 0;
    const adapter = adapterFor(getOrbitNetwork(ARBITRUM_SEPOLIA.id)!.usdc, {
      pollStatus: vi.fn(async () => ({ forwardState: 'PENDING' })),
      waitBeforeNextPoll: vi.fn(async () => { now += 3_000; }),
    });

    await expect(reconcileForwardingTransfer(sourceHash, adapter, { pollingWindowMs: 6_000, now: () => now }))
      .rejects.toBeInstanceOf(BridgeTrackingTimeoutError);
    expect(adapter.verifySourceReceipt).toHaveBeenCalledTimes(1);
    expect(adapter.pollStatus).toHaveBeenCalledTimes(2);
    expect(adapter.waitBeforeNextPoll).toHaveBeenCalledTimes(2);
  });

  it('does not continue if the source receipt is explicitly unsuccessful', async () => {
    const adapter = adapterFor(getOrbitNetwork(AVALANCHE_FUJI.id)!.usdc, {
      verifySourceReceipt: vi.fn(async () => false),
    });

    await expect(reconcileForwardingTransfer(sourceHash, adapter))
      .rejects.toThrow('source transaction receipt did not confirm successfully');
    expect(adapter.pollStatus).not.toHaveBeenCalled();
  });
});
