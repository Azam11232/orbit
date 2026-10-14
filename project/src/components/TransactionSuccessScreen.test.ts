import { describe, expect, it, vi } from 'vitest';
import { playSuccessChime } from './TransactionSuccessScreen';

describe('shared transaction success chime', () => {
  it('plays the shared three-note chime once per verified transaction key', () => {
    vi.useFakeTimers();
    const oscillatorStarts = vi.fn();
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const context = {
      state: 'running',
      currentTime: 0,
      destination: {},
      createGain: vi.fn(() => gain),
      createOscillator: vi.fn(() => ({
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: oscillatorStarts,
        stop: vi.fn(),
      })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const audioWindow = {
      AudioContext: vi.fn(function AudioContext() { return context; }),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    } as unknown as Window & typeof globalThis;
    vi.stubGlobal('window', audioWindow);

    try {
      playSuccessChime('gateway-deposit:source-hash');
      playSuccessChime('gateway-deposit:source-hash');

      expect(context.createOscillator).toHaveBeenCalledTimes(3);
      expect(oscillatorStarts).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
