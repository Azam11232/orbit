import { describe, expect, it } from 'vitest';
import { isBridgeReviewable } from './useBridgeQuote';

const ready = {
  isConnected: true,
  wrongNetwork: false,
  sameNetwork: false,
  hasSourceToken: true,
  hasDestinationToken: true,
  hasQuote: true,
  hasAmount: true,
  hasAmountError: false,
  approvalRequired: false,
  simulationSucceeded: true,
  isSimulating: false,
  quoteFresh: true,
};

describe('bridge review readiness', () => {
  it('requires successful source-chain simulation', () => {
    expect(isBridgeReviewable(ready)).toBe(true);
    expect(isBridgeReviewable({ ...ready, simulationSucceeded: false })).toBe(false);
    expect(isBridgeReviewable({ ...ready, isSimulating: true })).toBe(false);
  });

  it('keeps review disabled for invalid route or approval state', () => {
    expect(isBridgeReviewable({ ...ready, sameNetwork: true })).toBe(false);
    expect(isBridgeReviewable({ ...ready, approvalRequired: true })).toBe(false);
  });
});