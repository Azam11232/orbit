import { describe, expect, it } from 'vitest';
import { ARC_USDC, BASE_ERC20_ASSETS } from '../data/tokens';
import {
  ARC_PORTFOLIO_TOKENS,
  getPortfolioAnalytics,
  getPortfolioAssetCountState,
  getPortfolioAssetValue,
  getPortfolioUsdStatusLabel,
  isPortfolioReadEnabled,
  type PortfolioAsset,
} from './usePortfolio';
import { formatTokenBalance } from './useTokenBalance';

function arcAsset(overrides: Partial<PortfolioAsset> = {}): PortfolioAsset {
  return {
    symbol: 'USDC',
    name: 'USD Coin',
    formatted: '1.25',
    raw: 1_250_000n,
    color: '#2775CA',
    isLoading: false,
    isError: false,
    isNative: false,
    priceUsd: 1,
    valueUsd: 1.25,
    allocationPercent: 0,
    ...overrides,
  };
}

describe('Arc USDC balance configuration', () => {
  it('uses the official Arc Testnet ERC-20 address and six decimals', () => {
    expect(ARC_USDC.address).toBe('0x3600000000000000000000000000000000000000');
    expect(ARC_USDC.chainId).toBe(5042002);
    expect(ARC_USDC.decimals).toBe(6);
  });

  it('formats bigint balances without floating-point conversion', () => {
    expect(formatTokenBalance(1_000_000n, 6)).toBe('1');
    expect(formatTokenBalance(1_250_000n, 6)).toBe('1.25');
    expect(formatTokenBalance(9_007_199_254_740_993n, 6)).toBe('9007199254.740993');
    expect(formatTokenBalance(0n, 6)).toBe('0');
  });

  it('gates reads to a connected wallet on the token chain', () => {
    expect(isPortfolioReadEnabled(5042002, ARC_USDC.chainId, true, true)).toBe(true);
    expect(isPortfolioReadEnabled(8453, ARC_USDC.chainId, true, true)).toBe(false);
    expect(isPortfolioReadEnabled(5042002, ARC_USDC.chainId, false, true)).toBe(false);
    expect(isPortfolioReadEnabled(5042002, ARC_USDC.chainId, true, false)).toBe(false);
  });

  it('does not model a second native Arc gas asset', () => {
    expect(ARC_PORTFOLIO_TOKENS).toHaveLength(1);
    expect(ARC_PORTFOLIO_TOKENS[0].symbol).toBe('USDC');
    expect(ARC_PORTFOLIO_TOKENS[0].isNative).toBe(false);
    expect(ARC_PORTFOLIO_TOKENS.some((asset) => BASE_ERC20_ASSETS.some((baseAsset) => baseAsset.address === asset.address))).toBe(false);
  });

  it('allocates a funded USDC-only Arc portfolio at 100%', () => {
    const analytics = getPortfolioAnalytics([arcAsset()], [], 'Arc Testnet');
    expect(getPortfolioAssetValue('1.25', 1_250_000n, 1, false)).toBe(1.25);
    expect(analytics.totalValueUsd).toBe(1.25);
    expect(analytics.allocation[0].allocationPercent).toBe(100);
    expect(analytics.zeroBalance).toBe(false);
  });

  it('keeps a funded token distinct from a zero balance when USD pricing is unavailable', () => {
    const raw = 1_250_000n;
    const valueUsd = getPortfolioAssetValue('1.25', raw, null, false);
    const asset = arcAsset({ raw, formatted: '1.25', priceUsd: null, valueUsd });
    const analytics = getPortfolioAnalytics([asset], [], 'Arc Testnet');

    expect(asset.raw).toBe(raw);
    expect(analytics.totalValueUsd).toBeNull();
    expect(analytics.performance.valueUsd).toBeNull();
    expect(analytics.performance.available).toBe(false);
    expect(analytics.valuationUnavailable).toBe(true);
    expect(analytics.allocation[0].allocationPercent).toBeNull();
    expect(analytics.stablecoinExposurePercent).toBeNull();
    expect(analytics.concentrationPercent).toBeNull();
    expect(analytics.zeroBalance).toBe(false);
  });

  it('does not use cached prices after the price query fails', () => {
    const valueUsd = getPortfolioAssetValue('1.25', 1_250_000n, 1, true);
    const analytics = getPortfolioAnalytics([arcAsset({ valueUsd })]);

    expect(valueUsd).toBeNull();
    expect(analytics.performance.valueUsd).toBeNull();
    expect(analytics.totalValueUsd).toBeNull();
    expect(analytics.valuationUnavailable).toBe(true);
  });

  it('reports an empty Arc portfolio for a zero balance', () => {
    const valueUsd = getPortfolioAssetValue('0', 0n, null, true);
    const analytics = getPortfolioAnalytics([arcAsset({ formatted: '0', raw: 0n, priceUsd: null, valueUsd })], [], 'Arc Testnet');

    expect(analytics.totalValueUsd).toBe(0);
    expect(analytics.performance.valueUsd).toBe(0);
    expect(analytics.zeroBalance).toBe(true);
    expect(analytics.allocation[0].allocationPercent).toBe(0);
  });

  it('does not label disconnected portfolio values as live', () => {
    expect(getPortfolioUsdStatusLabel(true, false)).toBe('wallet not connected');
    expect(getPortfolioUsdStatusLabel(false, false)).toBe('live');
  });

  it('shows loading instead of a zero asset count before balance reads complete', () => {
    expect(getPortfolioAssetCountState(true, false, 0)).toEqual({ value: '…', label: 'LOADING' });
    expect(getPortfolioAssetCountState(false, false, 0)).toEqual({ value: '0', label: 'ASSETS' });
    expect(getPortfolioAssetCountState(false, false, 1)).toEqual({ value: '1', label: 'ASSETS' });
  });
});