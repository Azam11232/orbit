import { useAccount, useBalance } from 'wagmi';
import { formatEther } from 'viem';
import { base } from 'wagmi/chains';
import { useTokenBalance, type TokenConfig } from './useTokenBalance';
import { PORTFOLIO_PRICES } from '../services/prices';
import { usePrices } from './usePrices';
import { BASE_ERC20_ASSETS } from '../data/tokens';
import type { ChainTransaction } from '../services/transactions';

export interface PortfolioAsset {
  symbol: string;
  name: string;
  formatted: string;
  raw: bigint;
  color: string;
  isLoading: boolean;
  isError: boolean;
  isNative: boolean;
  priceUsd: number | null;
  valueUsd: number | null;
  allocationPercent: number;
}

export interface PortfolioData {
  assets: PortfolioAsset[];
  totalValueUsd: number;
  totalAssets: number;
  connectedAssets: number;
  isLoading: boolean;
  isError: boolean;
  hasUnavailablePrices: boolean;
  isDisconnected: boolean;
  isWrongNetwork: boolean;
}

export interface PortfolioAllocationSignal {
  symbol: string;
  name: string;
  color: string;
  valueUsd: number;
  allocationPercent: number;
  balance: string;
  raw: bigint;
}

export interface PortfolioRiskSignal {
  label: string;
  detail: string;
  value: number;
  tone: 'neutral' | 'warning';
}

export interface PortfolioPerformanceSignal {
  available: boolean;
  label: string;
  valueUsd: number | null;
  note: string;
  approximate: boolean;
}

export interface PortfolioHistoryState {
  available: boolean;
  title: string;
  note: string;
}

export interface TransactionInsight {
  title: string;
  detail: string;
  value: string;
  tone: 'in' | 'out' | 'neutral';
}

export interface PortfolioAnalytics {
  totalValueUsd: number;
  zeroBalance: boolean;
  allocation: PortfolioAllocationSignal[];
  topAsset: PortfolioAllocationSignal | null;
  stablecoinExposurePercent: number;
  ethExposurePercent: number;
  btcExposurePercent: number;
  volatileExposurePercent: number;
  concentrationPercent: number;
  riskSignals: PortfolioRiskSignal[];
  performance: PortfolioPerformanceSignal;
  history: PortfolioHistoryState;
  recentInsights: TransactionInsight[];
}

export const PORTFOLIO_TOKENS: TokenConfig[] = [
  ...BASE_ERC20_ASSETS.filter((asset) => asset.symbol === 'USDC' || asset.symbol === 'cbBTC'),
];

export function getPortfolioAnalytics(
  assets: PortfolioAsset[],
  transactions: ChainTransaction[] = [],
): PortfolioAnalytics {
  const totalValueUsd = assets.reduce((sum, asset) => sum + (asset.valueUsd ?? 0), 0);
  const allocation = assets
    .map((asset) => ({
      symbol: asset.symbol,
      name: asset.name,
      color: asset.color,
      valueUsd: asset.valueUsd ?? 0,
      allocationPercent: totalValueUsd > 0 && asset.valueUsd !== null ? (asset.valueUsd / totalValueUsd) * 100 : 0,
      balance: asset.formatted,
      raw: asset.raw,
    }))
    .sort((left, right) => right.valueUsd - left.valueUsd);

  const zeroBalance = allocation.every((asset) => asset.raw === 0n || asset.valueUsd === 0);
  const topAsset = allocation.find((asset) => asset.valueUsd > 0) ?? null;
  const stablecoinExposurePercent = totalValueUsd > 0
    ? allocation
        .filter((asset) => asset.symbol === 'USDC')
        .reduce((sum, asset) => sum + asset.valueUsd, 0) / totalValueUsd * 100
    : 0;
  const ethExposurePercent = totalValueUsd > 0
    ? allocation
        .filter((asset) => asset.symbol === 'ETH')
        .reduce((sum, asset) => sum + asset.valueUsd, 0) / totalValueUsd * 100
    : 0;
  const btcExposurePercent = totalValueUsd > 0
    ? allocation
        .filter((asset) => asset.symbol === 'cbBTC')
        .reduce((sum, asset) => sum + asset.valueUsd, 0) / totalValueUsd * 100
    : 0;
  const volatileExposurePercent = totalValueUsd > 0
    ? (ethExposurePercent + btcExposurePercent)
    : 0;

  const riskSignals: PortfolioRiskSignal[] = [];

  if (zeroBalance) {
    riskSignals.push({
      label: 'Zero-balance portfolio',
      detail: 'No ETH, USDC or cbBTC balance is currently detected on Base for this wallet.',
      value: 0,
      tone: 'neutral',
    });
  } else {
    const largest = topAsset ?? { symbol: 'N/A', valueUsd: 0, allocationPercent: 0 };
    riskSignals.push({
      label: 'Largest position',
      detail: `${largest.symbol} represents ${largest.allocationPercent.toFixed(1)}% of the portfolio value.`,
      value: largest.allocationPercent,
      tone: largest.allocationPercent > 60 ? 'warning' : 'neutral',
    });
    riskSignals.push({
      label: 'Stablecoin exposure',
      detail: `${stablecoinExposurePercent.toFixed(1)}% of the portfolio is held as stable value.`,
      value: stablecoinExposurePercent,
      tone: 'neutral',
    });
    riskSignals.push({
      label: 'Volatile asset exposure',
      detail: `${volatileExposurePercent.toFixed(1)}% is in ETH and cbBTC, which are more price-sensitive than stablecoins.`,
      value: volatileExposurePercent,
      tone: volatileExposurePercent > 75 ? 'warning' : 'neutral',
    });
  }

  const performance: PortfolioPerformanceSignal = {
    available: true,
    label: 'Current portfolio value',
    valueUsd: totalValueUsd,
    note: 'Live value from current Base balances and spot prices. Historical P&L is unavailable because ORBIT does not currently have a historical price or cost-basis record for this wallet.',
    approximate: false,
  };

  const history: PortfolioHistoryState = {
    available: false,
    title: 'Historical performance unavailable',
    note: 'This wallet has no reliable historical value snapshots or cost-basis data in the current ORBIT stack, so a chart or P&L calculation would be fabricated.',
  };

  const recentInsights: TransactionInsight[] = transactions.slice(0, 4).map((tx) => {
    const direction = tx.category === 'Receive' ? 'in' : tx.category === 'Send' ? 'out' : 'neutral';
    const shortValue = tx.value !== '0.000000' && tx.value !== '0' ? `${tx.value} ETH` : (tx.tokenTransfers.length > 0 ? `${tx.tokenTransfers.length} token transfer${tx.tokenTransfers.length > 1 ? 's' : ''}` : 'Activity');
    const title = tx.tokenTransfers.length > 0 ? 'Token transfer detected' : tx.category;
    const detail = tx.category === 'Receive'
      ? 'Inbound activity on Base'
      : tx.category === 'Send'
        ? 'Outbound activity on Base'
        : tx.category === 'Approval'
          ? 'Approval authority change'
          : tx.category === 'Swap'
            ? 'Swap routing or token exchange detected'
            : tx.category === 'Contract Interaction'
              ? 'Contract interaction recorded'
              : tx.category === 'Lending'
                ? 'Lending or borrowing interaction'
                : tx.category === 'Bridge'
                  ? 'Bridge activity detected'
                  : 'Onchain transaction recorded';

    return {
      title,
      detail,
      value: shortValue,
      tone: direction,
    };
  });

  return {
    totalValueUsd,
    zeroBalance,
    allocation,
    topAsset,
    stablecoinExposurePercent,
    ethExposurePercent,
    btcExposurePercent,
    volatileExposurePercent,
    concentrationPercent: topAsset ? topAsset.allocationPercent : 0,
    riskSignals,
    performance,
    history,
    recentInsights,
  };
}

export function usePortfolio(): PortfolioData {
  const { address, chainId, isConnected } = useAccount();

  const ethBalance = useBalance({
    address,
    chainId: base.id,
    query: {
      enabled: Boolean(address),
      staleTime: 30_000,
      gcTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  });
  const usdc = useTokenBalance(PORTFOLIO_TOKENS[0], address, isConnected);
  const cbbtc = useTokenBalance(PORTFOLIO_TOKENS[1], address, isConnected);
  const tokenResults = [usdc, cbbtc];
  const prices = usePrices(PORTFOLIO_PRICES);

  const isDisconnected = !isConnected || !address;
  const isWrongNetwork = isConnected && chainId !== base.id;

  const ethAsset: PortfolioAsset = {
    symbol: 'ETH',
    name: 'Ethereum',
    formatted: ethBalance.data ? formatEther(ethBalance.data.value) : '0',
    raw: ethBalance.data?.value ?? 0n,
    color: '#627EEA',
    isLoading: ethBalance.isLoading,
    isError: ethBalance.isError,
    isNative: true,
    priceUsd: prices.prices.ETH ?? null,
    valueUsd: null,
    allocationPercent: 0,
  };

  const tokenAssets: PortfolioAsset[] = PORTFOLIO_TOKENS.map((t, i) => ({
    symbol: t.symbol,
    name: t.name,
    formatted: tokenResults[i].formatted.toString(),
    raw: tokenResults[i].raw,
    color: t.color,
    isLoading: tokenResults[i].isLoading,
    isError: tokenResults[i].isError,
    isNative: false,
    priceUsd: prices.prices[t.symbol] ?? null,
    valueUsd: null,
    allocationPercent: 0,
  }));

  const assets = [ethAsset, ...tokenAssets].map((asset) => ({
    ...asset,
    valueUsd: asset.priceUsd === null ? null : Number(asset.formatted) * asset.priceUsd,
  }));
  const totalValueUsd = assets.reduce((sum, asset) => sum + (asset.valueUsd ?? 0), 0);
  const assetsWithAllocation = assets.map((asset) => ({
    ...asset,
    allocationPercent: totalValueUsd > 0 && asset.valueUsd !== null ? (asset.valueUsd / totalValueUsd) * 100 : 0,
  }));
  const connectedAssets = assets.filter((a) => a.raw > 0n).length;
  const anyLoading = assets.some((a) => a.isLoading) || prices.isLoading;
  const hasNativeBalanceData = ethBalance.data !== undefined;
  const anyOnchainError = (ethBalance.isError && !hasNativeBalanceData) || tokenResults.some((result) => result.isError && !result.raw);
  const anyPriceIssue = prices.isError || assets.some((asset) => asset.priceUsd === null);

  return {
    assets: assetsWithAllocation,
    totalValueUsd,
    totalAssets: assets.length,
    connectedAssets,
    isLoading: anyLoading,
    isError: !isDisconnected && !isWrongNetwork && anyOnchainError && !anyLoading,
    hasUnavailablePrices: !isDisconnected && !isWrongNetwork && !anyOnchainError && anyPriceIssue && !prices.isLoading,
    isDisconnected,
    isWrongNetwork,
  };
}
