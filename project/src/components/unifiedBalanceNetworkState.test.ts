import { describe, expect, it } from 'vitest';
import { isGatewayTransferRouteValid } from '../services/gateway';
import { getInitialTransferDestination, shouldShowFastGatewayDepositOption, updateUnifiedBalanceNetworkState } from './unifiedBalanceNetworkState';

describe('Unified Balance network selector state', () => {
  const initial = {
    depositSourceId: 5042002,
    transferSourceId: 5042002,
    transferDestinationId: 11155111,
  };

  it('keeps Deposit source independent from Transfer source and destination', () => {
    expect(updateUnifiedBalanceNetworkState(initial, { type: 'deposit-source', chainId: 84532 })).toEqual({
      ...initial,
      depositSourceId: 84532,
    });
  });

  it('keeps Transfer source independent from Deposit source and destination', () => {
    expect(updateUnifiedBalanceNetworkState(initial, { type: 'transfer-source', chainId: 421614 })).toEqual({
      ...initial,
      transferSourceId: 421614,
    });
  });

  it('keeps Transfer destination unchanged when source changes, even if that makes the route invalid', () => {
    const changedSource = updateUnifiedBalanceNetworkState(initial, { type: 'transfer-source', chainId: 11155111 });
    expect(changedSource.transferDestinationId).toBe(initial.transferDestinationId);
    expect(changedSource.transferDestinationId).toBe(changedSource.transferSourceId);
    expect(isGatewayTransferRouteValid(changedSource.transferSourceId, changedSource.transferDestinationId)).toBe(false);
  });

  it('initializes Transfer destination to a network different from its source', () => {
    expect(getInitialTransferDestination(11155111, [11155111, 84532, 421614])).toBe(84532);
  });

  it('offers Fast Deposit for Sepolia regardless of the independently selected Transfer destination', () => {
    expect(shouldShowFastGatewayDepositOption(11155111)).toBe(true);
    expect(shouldShowFastGatewayDepositOption(84532)).toBe(false);
  });
});
