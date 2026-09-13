import type { Address } from 'viem';
import { arcTestnet, base } from 'wagmi/chains';

export interface BaseAssetConfig {
  symbol: string;
  name: string;
  address?: Address;
  decimals: number;
  color: string;
  isNative: boolean;
  chainId: number;
}

export const BASE_ASSETS: BaseAssetConfig[] = [
  {
    symbol: 'ETH',
    name: 'Ethereum',
    decimals: 18,
    color: '#627EEA',
    isNative: true,
    chainId: base.id,
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x833589fcD6eDb6e08f4c7c32d4f71b54bdA02913',
    decimals: 6,
    color: '#2775CA',
    isNative: false,
    chainId: base.id,
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x4200000000000000000000000000000000000006',
    decimals: 18,
    color: '#627EEA',
    isNative: false,
    chainId: base.id,
  },
  {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    decimals: 8,
    color: '#F7931A',
    isNative: false,
    chainId: base.id,
  },
];

export const BASE_ERC20_ASSETS = BASE_ASSETS.filter(
  (asset): asset is BaseAssetConfig & { address: Address } => Boolean(asset.address),
);

export const BASE_SWAP_ASSETS = BASE_ASSETS.filter((asset) => asset.symbol !== 'WETH');

export const ARC_USDC: BaseAssetConfig & { address: Address } = {
  symbol: 'USDC',
  name: 'USD Coin',
  address: '0x3600000000000000000000000000000000000000',
  decimals: 6,
  color: '#2775CA',
  isNative: false,
  chainId: arcTestnet.id,
};

export const ARC_EURC: BaseAssetConfig & { address: Address } = {
  symbol: 'EURC',
  name: 'Euro Coin',
  address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  decimals: 6,
  color: '#6B8AFD',
  isNative: false,
  chainId: arcTestnet.id,
};

export const ARC_ERC20_ASSETS = [ARC_USDC];
export const ARC_SWAP_ASSETS = [ARC_USDC, ARC_EURC];
