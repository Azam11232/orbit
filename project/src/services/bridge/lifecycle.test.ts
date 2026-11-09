import { describe, expect, it, vi } from 'vitest';
import type { Hash } from 'viem';
import type { BridgeStatus } from '../../types/bridge';
import { createBridgeExecutionGate, pollCctpAttestation, resumeCctpBridgeLifecycle, runCctpBridgeLifecycle } from './lifecycle';

const sourceHash = `0x${'a'.repeat(64)}` as Hash;

describe('CCTP bridge lifecycle', () => {
  it('prevents duplicate submissions while active and after a source submission', () => {
    const gate = createBridgeExecutionGate();

    expect(gate.begin()).toBe(true);
    expect(gate.begin()).toBe(false);
    expect(gate.reset()).toBe(false);
    gate.markSourceSubmitted();
    gate.finish();
    expect(gate.begin()).toBe(false);
    expect(gate.reset()).toBe(true);
    expect(gate.begin()).toBe(true);
    gate.finish();
  });

  it('submits once and reaches attestation-ready after an explicit lifecycle start', async () => {
    const submitSource = vi.fn(async () => sourceHash);
    const pollAttestation = vi.fn()
      .mockResolvedValueOnce({ status: 'PENDING' as const })
      .mockResolvedValueOnce({
        status: 'DONE' as const,
        message: '0x1234' as const,
        attestation: '0xabcd' as const,
      });
    const waitBeforeNextPoll = vi.fn(async () => undefined);
    const updates: string[] = [];

    await runCctpBridgeLifecycle({
      submitSource,
      waitForSource: async () => undefined,
      pollAttestation,
      waitBeforeNextPoll,
    }, (snapshot) => updates.push(snapshot.status));

    expect(submitSource).toHaveBeenCalledTimes(1);
    expect(pollAttestation).toHaveBeenCalledTimes(2);
    expect(waitBeforeNextPoll).toHaveBeenCalledTimes(1);
    expect(updates).toContain('source-pending');
    expect(updates).toContain('attestation-ready');
  });

  it('does not poll attestation after a source receipt fails', async () => {
    const submitSource = vi.fn(async () => sourceHash);
    const pollAttestation = vi.fn(async () => ({ status: 'DONE' as const }));

    await expect(runCctpBridgeLifecycle({
      submitSource,
      waitForSource: async () => { throw new Error('Source receipt reverted.'); },
      pollAttestation,
      waitBeforeNextPoll: async () => undefined,
    }, () => undefined)).rejects.toThrow('Source receipt reverted');

    expect(submitSource).toHaveBeenCalledTimes(1);
    expect(pollAttestation).not.toHaveBeenCalled();
  });

  it('bounds status polling and never resubmits the source transaction', async () => {
    const pollAttestation = vi.fn(async () => ({ status: 'PENDING' as const }));
    const waitBeforeNextPoll = vi.fn(async () => undefined);

    await expect(pollCctpAttestation(sourceHash, {
      pollAttestation,
      waitBeforeNextPoll,
    }, () => undefined, 3)).rejects.toThrow('still pending after 3 checks');

    expect(pollAttestation).toHaveBeenCalledTimes(3);
    expect(waitBeforeNextPoll).toHaveBeenCalledTimes(2);
  });

  it('resumes prolonged attestation polling with the original source hash and reaches mint-ready', async () => {
    const submitSource = vi.fn(async () => sourceHash);
    const pollAttestation = vi.fn(async (hash: Hash): Promise<BridgeStatus> => {
      expect(hash).toBe(sourceHash);
      return { status: 'PENDING' };
    });
    const waitBeforeNextPoll = vi.fn(async () => undefined);
    const updates: string[] = [];

    await expect(runCctpBridgeLifecycle({
      submitSource,
      waitForSource: async () => undefined,
      pollAttestation,
      waitBeforeNextPoll,
    }, () => undefined, 2)).rejects.toThrow('source transaction will not be resubmitted');

    pollAttestation
      .mockResolvedValueOnce({
        status: 'DONE',
        message: '0x1234',
        attestation: '0xabcd',
      });

    const status = await resumeCctpBridgeLifecycle(sourceHash, {
      pollAttestation,
      waitBeforeNextPoll,
    }, (snapshot) => updates.push(snapshot.status));

    expect(status.status).toBe('DONE');
    expect(status.message).toBe('0x1234');
    expect(status.attestation).toBe('0xabcd');
    expect(pollAttestation).toHaveBeenNthCalledWith(3, sourceHash);
    expect(submitSource).toHaveBeenCalledTimes(1);
    expect(updates).toContain('attestation-ready');
  });

  it('continues past twenty pending checks without changing the source hash', async () => {
    const pollAttestation = vi.fn(async (hash: Hash): Promise<BridgeStatus> => {
      expect(hash).toBe(sourceHash);
      return { status: 'PENDING' };
    });
    const waitBeforeNextPoll = vi.fn(async () => undefined);

    for (let attempt = 0; attempt < 21; attempt += 1) {
      pollAttestation.mockResolvedValueOnce({ status: 'PENDING' });
    }
    pollAttestation.mockResolvedValueOnce({
      status: 'DONE',
      message: '0x1234',
      attestation: '0xabcd',
    });

    const status = await resumeCctpBridgeLifecycle(sourceHash, {
      pollAttestation,
      waitBeforeNextPoll,
    }, () => undefined, 22);

    expect(status.status).toBe('DONE');
    expect(pollAttestation).toHaveBeenCalledTimes(22);
    expect(pollAttestation.mock.calls.every(([hash]) => hash === sourceHash)).toBe(true);
  });

  it('times out a status request that never settles', async () => {
    const pollAttestation = vi.fn(() => new Promise<never>(() => undefined));

    await expect(pollCctpAttestation(sourceHash, {
      pollAttestation,
      waitBeforeNextPoll: async () => undefined,
    }, () => undefined, 1, 5)).rejects.toThrow('Circle status request timed out');

    expect(pollAttestation).toHaveBeenCalledTimes(1);
  });
});
