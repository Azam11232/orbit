import { FAST_GATEWAY_DEPOSIT_SOURCE_CHAIN_ID } from '../services/gatewayFastDeposit';

export interface UnifiedBalanceNetworkState {
  depositSourceId: number;
  transferSourceId: number;
  transferDestinationId: number;
}

export type UnifiedBalanceNetworkAction =
  | { type: 'deposit-source'; chainId: number }
  | { type: 'transfer-source'; chainId: number }
  | { type: 'transfer-destination'; chainId: number };

export function updateUnifiedBalanceNetworkState(
  state: UnifiedBalanceNetworkState,
  action: UnifiedBalanceNetworkAction,
): UnifiedBalanceNetworkState {
  if (action.type === 'deposit-source') return { ...state, depositSourceId: action.chainId };
  if (action.type === 'transfer-source') return { ...state, transferSourceId: action.chainId };
  return { ...state, transferDestinationId: action.chainId };
}

export function getInitialTransferDestination(transferSourceId: number, networkIds: readonly number[]) {
  return networkIds.find((networkId) => networkId !== transferSourceId) ?? transferSourceId;
}

export function shouldShowFastGatewayDepositOption(depositSourceId: number) {
  return depositSourceId === FAST_GATEWAY_DEPOSIT_SOURCE_CHAIN_ID;
}
