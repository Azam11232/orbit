import type { Address } from 'viem';

export interface LendingAssetConfig {
  symbol: 'USDC' | 'WETH';
  name: string;
  underlying: Address;
  decimals: number;
  color: string;
}

export interface LendingAssetPosition extends LendingAssetConfig {
  supplied: bigint;
  borrowed: bigint;
  supplyApy: number | null;
  borrowApr: number | null;
  liquidity: bigint | null;
  priceBase: bigint | null;
  aToken: Address;
  variableDebtToken: Address;
}

export interface LendingPosition {
  assets: LendingAssetPosition[];
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint;
  healthFactor: bigint;
  ltv: bigint;
  protocol: string;
}

export type LendingOperation = 'supply' | 'withdraw' | 'borrow' | 'repay';
export type LendingStatus = 'idle' | 'confirmation' | 'pending' | 'confirmed' | 'failed';
