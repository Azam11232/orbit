import { formatUnits, type Address } from 'viem';
import type { SwapBuildRequest, SwapProvider, SwapTransaction } from '../../types/swap';

const BASE_ROUTE_URL = 'https://aggregator-api.kyberswap.com/base/api/v1/routes';

interface KyberRouteResponse {
  data?: {
    routeSummary?: {
      amountIn?: string;
      amountOut?: string;
      gas?: string;
      gasPrice?: string;
      gasUsd?: number | string;
      priceImpact?: number | string;
      route?: unknown;
      limitReturnAmount?: string;
    };
    routerAddress?: string;
    data?: string;
    code?: number | string;
    message?: string;
    limitReturnAmount?: string;
    priceImpact?: number | string;
  };
  code?: number | string;
  message?: string;
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function asAddress(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? value as Address : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed.replace(/%/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function parseGasPriceWei(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const [whole, fraction = ''] = String(value).split('.');
    return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0').slice(0, 9) || '0');
  } catch {
    return null;
  }
}

export function createKyberSwapProvider(): SwapProvider {
  return {
    async getQuote({ tokenIn, tokenOut, amountIn }) {
      const params = new URLSearchParams({
        tokenIn: tokenIn.address ?? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        tokenOut: tokenOut.address ?? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        amountIn: amountIn.toString(),
        gasInclude: 'true',
      });
      const response = await fetch(`${BASE_ROUTE_URL}?${params.toString()}`, {
        headers: { 'x-client-id': 'orbit-app' },
      });
      if (!response.ok) throw new Error(`Swap quote unavailable (${response.status})`);
      const json = await response.json() as KyberRouteResponse;
      if (!json.data || json.code !== undefined && String(json.code) !== '0') {
        throw new Error(json.message || 'No route available');
      }
      const routeSummary = json.data.routeSummary;
      const amountOut = asBigInt(routeSummary?.amountOut);
      if (amountOut === null || amountOut <= 0n) throw new Error('No route available');
      const gas = asBigInt(routeSummary?.gas);
      const gasPriceWei = asBigInt(routeSummary?.gasPrice) ?? parseGasPriceWei(routeSummary?.gasPrice);
      const gasUsd = typeof routeSummary?.gasUsd === 'number' ? routeSummary.gasUsd : typeof routeSummary?.gasUsd === 'string' ? Number(routeSummary.gasUsd) : null;
      const priceImpact = asNumber(routeSummary?.priceImpact ?? json.data.priceImpact ?? null);
      const minimumReceivedSource = asBigInt(json.data.limitReturnAmount ?? routeSummary?.limitReturnAmount ?? null);
      return {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        minimumReceived: minimumReceivedSource,
        routerAddress: asAddress(json.data.routerAddress),
        gas,
        gasPriceWei,
        gasUsd: gasUsd !== null && Number.isFinite(gasUsd) ? gasUsd : null,
        priceImpact: priceImpact !== null && Number.isFinite(priceImpact) && priceImpact >= 0 ? priceImpact : null,
        routeLabel: 'KyberSwap route',
        routeSummary: routeSummary ?? null,
        quotedAt: Date.now(),
      };
    },
    async buildTransaction({ quote, sender, recipient, slippageBps, deadline }: SwapBuildRequest): Promise<SwapTransaction> {
      if (!quote.routerAddress || !quote.routeSummary) throw new Error('Quote cannot be prepared for execution');
      const response = await fetch('https://aggregator-api.kyberswap.com/base/api/v1/route/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': 'orbit-app' },
        body: JSON.stringify({
          routeSummary: quote.routeSummary,
          sender,
          recipient,
          slippageTolerance: slippageBps,
          deadline: Number(deadline),
          enableGasEstimation: true,
        }),
      });
      if (!response.ok) throw new Error(`Swap transaction unavailable (${response.status})`);
      const json = await response.json() as KyberRouteResponse;
      const data = json.data;
      const encodedData = data?.data;
      const routerAddress = asAddress(data?.routerAddress ?? quote.routerAddress);
      if (!data || !encodedData || !/^0x[0-9a-fA-F]*$/.test(encodedData) || !routerAddress || (json.code !== undefined && String(json.code) !== '0')) {
        throw new Error(data?.message || json.message || 'Swap transaction data could not be verified');
      }
      const minimumReceived = asBigInt(data.limitReturnAmount ?? data.routeSummary?.limitReturnAmount) ?? (quote.amountOut * BigInt(10_000 - slippageBps) / 10_000n);
      return {
        to: routerAddress,
        data: encodedData as `0x${string}`,
        value: quote.tokenIn.isNative ? quote.amountIn : 0n,
        routerAddress,
        deadline,
        minimumReceived,
      };
    },
  };
}

export function formatQuoteAmount(amount: bigint, asset: { decimals: number }): string {
  return formatUnits(amount, asset.decimals);
}
