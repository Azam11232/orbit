import { describe, expect, it, vi } from 'vitest';
import {
  pollForGatewayDepositAvailability,
  waitForGatewayPollInterval,
  watchConfirmedGatewayDeposit,
} from './gatewayDepositPolling';

describe('Gateway deposit availability polling', () => {
  it('notifies immediately after transaction confirmation without waiting for availability polling', async () => {
    let resolveBalance!: (balance: bigint) => void;
    const order: string[] = [];
    const pending = watchConfirmedGatewayDeposit({
      onConfirmed: () => order.push('confirmed'),
      readAvailableBalance: () => {
        order.push('read');
        return new Promise((resolve) => { resolveBalance = resolve; });
      },
      baselineBalance: 2_000_000n,
      depositAmount: 3_000_000n,
      signal: new AbortController().signal,
    });

    expect(order).toEqual(['confirmed', 'read']);
    resolveBalance(5_000_000n);
    await expect(pending).resolves.toBe('available');
  });

  it('keeps polling after delayed API balance updates and uses exponential backoff', async () => {
    const balances = [1_000_000n, 1_000_000n, 4_000_000n];
    const delays: number[] = [];
    const result = await pollForGatewayDepositAvailability({
      readAvailableBalance: async () => balances.shift()!,
      baselineBalance: 1_000_000n,
      depositAmount: 3_000_000n,
      signal: new AbortController().signal,
      initialIntervalMs: 1_000,
      maxIntervalMs: 5_000,
      wait: async (delay) => { delays.push(delay); return true; },
    });

    expect(result).toBe('available');
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('clears the pending polling timer when the watcher is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const pending = waitForGatewayPollInterval(60_000, controller.signal);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      await expect(pending).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries transient API failures and times out honestly if the balance never increases', async () => {
    let now = 0;
    let reads = 0;
    const delays: number[] = [];
    const onReadError = vi.fn();
    const result = await pollForGatewayDepositAvailability({
      readAvailableBalance: async () => {
        reads += 1;
        if (reads === 1) throw new Error('Circle API temporarily unavailable');
        return 8_000_000n;
      },
      baselineBalance: 8_000_000n,
      depositAmount: 2_000_000n,
      signal: new AbortController().signal,
      timeoutMs: 350,
      initialIntervalMs: 100,
      maxIntervalMs: 200,
      now: () => now,
      wait: async (delay) => { delays.push(delay); now += delay; return true; },
      onReadError,
    });

    expect(result).toBe('timeout');
    expect(onReadError).toHaveBeenCalledOnce();
    expect(delays).toEqual([100, 200, 50]);
  });

  it('allows a later explicit retry to observe a balance that arrived after timeout', async () => {
    const result = await pollForGatewayDepositAvailability({
      readAvailableBalance: async () => 8_000_000n,
      baselineBalance: 8_000_000n,
      depositAmount: 2_000_000n,
      signal: new AbortController().signal,
      timeoutMs: 0,
    });
    expect(result).toBe('timeout');

    const retry = await pollForGatewayDepositAvailability({
      readAvailableBalance: async () => 10_000_000n,
      baselineBalance: 8_000_000n,
      depositAmount: 2_000_000n,
      signal: new AbortController().signal,
    });
    expect(retry).toBe('available');
  });

  it('does not call the deposit available unless the pre-deposit balance increases by the full deposit', async () => {
    let now = 0;
    const result = await pollForGatewayDepositAvailability({
      readAvailableBalance: async () => 14n,
      baselineBalance: 10n,
      depositAmount: 5n,
      signal: new AbortController().signal,
      timeoutMs: 20,
      initialIntervalMs: 10,
      maxIntervalMs: 10,
      now: () => now,
      wait: async (delay) => { now += delay; return true; },
    });

    expect(result).toBe('timeout');
  });
});
