import { useAccount } from 'wagmi';
import { arcTestnet } from 'wagmi/chains';
import { useTokenBalance, type TokenConfig } from './useTokenBalance';
import { PORTFOLIO_PRICES } from '../services/prices';
import { usePrices } from './usePrices';
import { ARC_ERC20_ASSETS } from '../data/tokens';
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
  refetch: () => Promise<unknown>;
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
  ...ARC_ERC20_ASSETS,
];

export const ARC_PORTFOLIO_TOKENS: TokenConfig[] = [...ARC_ERC20_ASSETS];

export function isPortfolioReadEnabled(
  chainId: number | undefined,
  tokenChainId: number,
  isConnected: boolean,
  hasAddress: boolean,
): boolean {
  return hasAddress && isConnected && chainId === tokenChainId;
}

export function getPortfolioAnalytics(
  assets: PortfolioAsset[],
  transactions: ChainTransaction[] = [],
  networkLabel = 'Arc Testnet',
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

  const zeroBalance = allocation.every((asset) => asset.raw === 0n);
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
      detail: `No supported asset balance is currently detected on ${networkLabel} for this wallet.`,
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
    note: `Live value from current ${networkLabel} balances and spot prices. Historical P&L is unavailable because ORBIT does not currently have a historical price or cost-basis record for this wallet.`,
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
      ? `Inbound activity on ${networkLabel}`
      : tx.category === 'Send'
        ? `Outbound activity on ${networkLabel}`
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
  const isArc = chainId === arcTestnet.id;
  const activeTokens = isArc ? ARC_PORTFOLIO_TOKENS : [];
  const arcUsdc = useTokenBalance(ARC_PORTFOLIO_TOKENS[0], address, isPortfolioReadEnabled(chainId, ARC_PORTFOLIO_TOKENS[0].chainId, isConnected, Boolean(address)));
  const tokenResults = isArc ? [arcUsdc] : [];
  const prices = usePrices(PORTFOLIO_PRICES);

  const isDisconnected = !isConnected || !address;
  const isWrongNetwork = isConnected && !isArc;

  const tokenAssets: PortfolioAsset[] = activeTokens.map((t, i) => ({
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

  const assets = (isArc ? tokenAssets : []).map((asset) => {
    const numericBalance = Number(asset.formatted);
    const valueUsd = Number.isFinite(numericBalance) && asset.priceUsd !== null && Number.isFinite(asset.priceUsd)
      ? numericBalance * asset.priceUsd
      : null;

    return {
      ...asset,
      valueUsd,
    };
  });

  const validValueAssets = assets.filter((asset) => asset.valueUsd !== null && Number.isFinite(asset.valueUsd));
  const totalValueUsd = validValueAssets.reduce((sum, asset) => sum + (asset.valueUsd ?? 0), 0);
  const assetsWithAllocation = assets.map((asset) => ({
    ...asset,
    allocationPercent: totalValueUsd > 0 && asset.valueUsd !== null && Number.isFinite(asset.valueUsd)
      ? (asset.valueUsd / totalValueUsd) * 100
      : 0,
  }));

  const connectedAssets = assets.filter((asset) => asset.raw > 0n).length;
  const anyLoading = assets.some((asset) => asset.isLoading) || prices.isLoading;
  const hasAnyBalanceData = assets.some((asset) => asset.raw > 0n);
  const hasAnyPriceIssue = assets.some((asset) => asset.raw > 0n && asset.priceUsd === null);
  const hasAnyOnchainError = tokenResults.some((result) => result.isError);

  return {
    assets: assetsWithAllocation,
    totalValueUsd,
    totalAssets: assets.length,
    connectedAssets,
    isLoading: anyLoading,
    isError: !isDisconnected && !isWrongNetwork && !anyLoading && !hasAnyBalanceData && hasAnyOnchainError,
    hasUnavailablePrices: !isDisconnected && !isWrongNetwork && !anyLoading && hasAnyPriceIssue,
    isDisconnected,
    isWrongNetwork,
    refetch: async () => {
      await Promise.all([
        ...tokenResults.map((result) => result.refetch()),
        prices.refetch(),
      ]);
    },
  };
}
