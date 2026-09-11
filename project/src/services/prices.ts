export interface PriceAssetConfig {
  symbol: string;
  coingeckoId: string;
  llamaId?: string;
}

export interface AssetPrice {
  symbol: string;
  usd: number;
}

interface CoinGeckoResponse {
  [id: string]: { usd?: number };
}

interface LlamaPrice {
  price?: number;
}

interface LlamaResponse {
  coins?: Record<string, LlamaPrice>;
}

export interface PriceProvider {
  fetchPrices(assets: PriceAssetConfig[]): Promise<Record<string, number>>;
}

export interface HistoricalCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const LLAMA_URL = 'https://coins.llama.fi/prices/current';
const COINGECKO_CHART_URL = 'https://api.coingecko.com/api/v3/coins';

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Price API error: ${response.status}`);
  return response.json() as Promise<T>;
}

function parsePrices(assets: PriceAssetConfig[], response: CoinGeckoResponse): Record<string, number> {
  return Object.fromEntries(
    assets.flatMap((asset) => {
      const price = response[asset.coingeckoId]?.usd;
      return typeof price === 'number' && Number.isFinite(price) && price >= 0
        ? [[asset.symbol, price]]
        : [];
    }),
  );
}

async function fetchCoinGeckoPrices(assets: PriceAssetConfig[]): Promise<Record<string, number>> {
  const ids = assets.map((asset) => asset.coingeckoId).join(',');
  const response = await readJson<CoinGeckoResponse>(`${COINGECKO_URL}?ids=${encodeURIComponent(ids)}&vs_currencies=usd`);
  const prices = parsePrices(assets, response);
  if (Object.keys(prices).length !== assets.length) throw new Error('Price API returned incomplete data');
  return prices;
}

async function fetchLlamaPrices(assets: PriceAssetConfig[]): Promise<Record<string, number>> {
  const coins = assets.map((asset) => `coingecko:${asset.llamaId ?? asset.coingeckoId}`).join(',');
  const response = await readJson<LlamaResponse>(`${LLAMA_URL}/${encodeURIComponent(coins)}`);
  const prices = Object.fromEntries(
    assets.flatMap((asset) => {
      const price = response.coins?.[`coingecko:${asset.llamaId ?? asset.coingeckoId}`]?.price;
      return typeof price === 'number' && Number.isFinite(price) && price >= 0
        ? [[asset.symbol, price]]
        : [];
    }),
  );
  if (Object.keys(prices).length !== assets.length) throw new Error('Fallback price API returned incomplete data');
  return prices;
}

export function createPriceProvider(): PriceProvider {
  return {
    async fetchPrices(assets) {
      try {
        return await fetchCoinGeckoPrices(assets);
      } catch (primaryError) {
        try {
          return await fetchLlamaPrices(assets);
        } catch {
          throw new Error(primaryError instanceof Error ? primaryError.message : 'Unable to load asset prices');
        }
      }
    },
  };
}

export const PORTFOLIO_PRICES: PriceAssetConfig[] = [
  { symbol: 'ETH', coingeckoId: 'ethereum' },
  { symbol: 'USDC', coingeckoId: 'usd-coin' },
  { symbol: 'cbBTC', coingeckoId: 'coinbase-wrapped-btc' },
];

function toCandles(prices: Array<[number, number]>): HistoricalCandle[] {
  if (prices.length === 0) {
    return [];
  }

  return prices.map(([time, close], index) => {
    const previousClose = index === 0 ? close : prices[index - 1][1];
    const open = previousClose;
    const high = Math.max(open, close);
    const low = Math.min(open, close);

    return {
      time,
      open,
      high,
      low,
      close,
    };
  });
}

export async function fetchHistoricalCandles(symbol: string, days = 14): Promise<HistoricalCandle[]> {
  const asset = PORTFOLIO_PRICES.find((entry) => entry.symbol === symbol);
  if (!asset) {
    return [];
  }

  const response = await readJson<{ prices: Array<[number, number]> }>(
    `${COINGECKO_CHART_URL}/${encodeURIComponent(asset.coingeckoId)}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
  );

  return toCandles(response.prices.slice(-days));
}

export async function fetchPortfolioHistoricalCandles(
  balances: Array<{ symbol: string; raw: bigint; decimals: number }>,
  days = 30,
): Promise<HistoricalCandle[]> {
  const activeBalances = balances.filter((item) => item.raw > 0n);
  if (activeBalances.length === 0) {
    return [];
  }

  const seriesBySymbol = await Promise.all(
    activeBalances.map(async (asset) => ({
      symbol: asset.symbol,
      candles: await fetchHistoricalCandles(asset.symbol, days),
    })),
  );

  const maxLength = Math.max(...seriesBySymbol.map((entry) => entry.candles.length), 0);
  if (maxLength === 0) {
    return [];
  }

  const portfolioSeries: HistoricalCandle[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    const portfolioValue = activeBalances.reduce((sum, asset) => {
      const assetSeries = seriesBySymbol.find((entry) => entry.symbol === asset.symbol);
      const candle = assetSeries?.candles[index];
      if (!candle) {
        return sum;
      }

      const balance = Number(asset.raw) / 10 ** asset.decimals;
      if (!Number.isFinite(balance) || balance <= 0) {
        return sum;
      }

      return sum + balance * candle.close;
    }, 0);

    if (!Number.isFinite(portfolioValue) || portfolioValue <= 0) {
      continue;
    }

    const timestamp = seriesBySymbol[0]?.candles[index]?.time ?? Date.now();
    const previousClose = portfolioSeries[portfolioSeries.length - 1]?.close ?? portfolioValue;
    const open = index === 0 ? portfolioValue : previousClose;
    const high = Math.max(open, portfolioValue);
    const low = Math.min(open, portfolioValue);
    const close = portfolioValue;

    portfolioSeries.push({
      time: timestamp,
      open,
      high,
      low,
      close,
    });
  }

  return portfolioSeries;
}
