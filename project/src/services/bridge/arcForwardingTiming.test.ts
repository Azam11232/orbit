import { afterEach, describe, expect, it, vi } from 'vitest';
import { associateBridgeQuoteTiming, beginArcForwardingTiming, getBridgeQuoteTiming, timeArcForwardingAwait } from './arcForwardingTiming';

describe('Bridge timing instrumentation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attributes elapsed time to the stage and counts failed attempts as retries', async () => {
    let now = 100;
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const timing = beginArcForwardingTiming('quote requested', () => now);
    const quote = associateBridgeQuoteTiming({}, timing);

    await expect(timeArcForwardingAwait(timing, 'Circle forwarding status request', async () => {
      now = 130;
      throw new Error('request rejected; signature=must-not-be-logged');
    })).rejects.toThrow('request rejected');

    const result = await timeArcForwardingAwait(timing, 'Circle forwarding status request', async () => {
      now = 180;
      return 'ready';
    });

    expect(result).toBe('ready');
    expect(getBridgeQuoteTiming(quote)).toBe(timing);
    const events = log.mock.calls.map(([, event]) => event as Record<string, unknown>);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'stage_failed', stage: 'Circle forwarding status request', attempt: 1, retryCount: 0, durationMs: 30, errorCategory: 'wallet_rejected' }),
      expect.objectContaining({ event: 'stage_started', stage: 'Circle forwarding status request', attempt: 2, retryCount: 1, elapsedMs: 30 }),
      expect.objectContaining({ event: 'stage_completed', stage: 'Circle forwarding status request', attempt: 2, retryCount: 1, durationMs: 50, elapsedMs: 80 }),
    ]));
    expect(JSON.stringify(log.mock.calls)).not.toContain('must-not-be-logged');
  });
});
