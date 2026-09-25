import { describe, expect, it } from 'vitest';
import { isBridgeReviewable, isManualBridgeSimulationRequired } from './useBridgeQuote';

const ready = {
  isConnected: true,
  wrongNetwork: false,
  sameNetwork: false,
  hasSourceToken: true,
  hasDestinationToken: true,
  hasQuote: true,
  hasAmount: true,
  hasAmountError: false,
  quoteFresh: true,
};

describe('route-aware bridge simulation gating', () => {
  it('requires legacy CCTP burn simulation only for the CCTP route', () => {
    expect(isManualBridgeSimulationRequired('forwarding')).toBe(false);
    expect(isManualBridgeSimulationRequired('cctp')).toBe(true);
  });
});

describe('bridge review readiness', () => {
  it('allows review for a valid route and amount', () => {
    expect(isBridgeReviewable(ready)).toBe(true);
    expect(isBridgeReviewable({ ...ready, sameNetwork: true })).toBe(false);
  });
});