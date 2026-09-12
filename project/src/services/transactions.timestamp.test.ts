import { describe, expect, it } from 'vitest';
import { normalizeTimestamp } from './transactions';

describe('normalizeTimestamp', () => {
  it('normalizes unix seconds to milliseconds', () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('preserves unix milliseconds', () => {
    expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('normalizes ISO timestamps', () => {
    expect(normalizeTimestamp('2026-04-30T15:02:00Z')).toBe(new Date('2026-04-30T15:02:00Z').getTime());
  });

  it('rejects invalid timestamps', () => {
    expect(normalizeTimestamp('')).toBeNull();
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp(0)).toBeNull();
    expect(normalizeTimestamp('not-a-date')).toBeNull();
  });
});
