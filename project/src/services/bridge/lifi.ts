import type { Address, Hex } from 'viem';
import type { BridgeProvider, BridgeStatus, BridgeToken } from '../../types/bridge';

const BASE_URL = 'https://li.quest/v1';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

interface LifiToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  chainId: number;
  coinKey?: string;
}

interface LifiQuoteResponse {
  id?: string;
  toolDetails?: { name?: string; key?: string };
  action?: { fromChainId?: number; toChainId?: number; fromToken?: LifiToken; toToken?: LifiToken; fromAmount?: string; toAmount?: string };
  estimate?: { toAmount?: string; toAmountMin?: string; feeCosts?: Array<{ amount?: string }>; gasCosts?: Array<{ amount?: string }>; executionDuration?: number };
  transactionRequest?: { to?: string; data?: string; value?: string };
  tool?: string;
  bridge?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`LI.FI request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function asAddress(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? value as Address : null;
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try { return BigInt(value); } catch { return null; }
}

function toToken(token: LifiToken): BridgeToken {
  const address = asAddress(token.address);
  if (!address) throw new Error(`LI.FI returned an invalid token address for ${token.symbol}`);
  return { chainId: token.chainId, address, symbol: token.symbol, name: token.name, decimals: token.decimals, logoURI: token.logoURI, isNative: address.toLowerCase() === ZERO_ADDRESS };
}

export function createLifiProvider(): BridgeProvider {
  return {
    async getTokens(chainIds) {
      const json = await getJson<{ tokens?: Record<string, LifiToken[]> }>(`${BASE_URL}/tokens?chains=${chainIds.join(',')}`);
      return Object.values(json.tokens ?? {}).flat().filter((token) => token.coinKey === 'ETH' || token.coinKey === 'USDC').map(toToken);
    },
    async getQuote(request) {
      if (request.fromChain.id === request.toChain.id) throw new Error('Source and destination chains must differ');
      const params = new URLSearchParams({
        fromChain: String(request.fromChain.id),
        toChain: String(request.toChain.id),
        fromToken: request.fromToken.address,
        toToken: request.toToken.address,
        fromAmount: request.fromAmount.toString(),
        fromAddress: request.fromAddress,
        toAddress: request.toAddress,
        slippage: String(request.slippage),
      });
      const json = await getJson<LifiQuoteResponse>(`${BASE_URL}/quote?${params.toString()}`);
      const toAmount = asBigInt(json.estimate?.toAmount ?? json.action?.toAmount);
      if (!toAmount || toAmount <= 0n || !json.transactionRequest?.to || !json.transactionRequest.data) throw new Error('No route available');
      const target = asAddress(json.transactionRequest.to);
      if (!target) throw new Error('LI.FI returned an invalid transaction target');
      return {
        id: json.id ?? `${request.fromChain.id}-${request.toChain.id}-${Date.now()}`,
        provider: json.toolDetails?.name ?? json.tool ?? 'LI.FI',
        fromChain: request.fromChain,
        toChain: request.toChain,
        fromToken: request.fromToken,
        toToken: request.toToken,
        fromAmount: request.fromAmount,
        toAmount,
        toAmountMin: asBigInt(json.estimate?.toAmountMin),
        feeAmount: asBigInt(json.estimate?.feeCosts?.[0]?.amount),
        gasAmount: asBigInt(json.estimate?.gasCosts?.[0]?.amount),
        gasCosts: (json.estimate?.gasCosts ?? []).flatMap((cost) => cost.amount ? [cost.amount] : []),
        executionDurationSeconds: json.estimate?.executionDuration ?? null,
        transactionTarget: target,
        transactionData: json.transactionRequest.data as Hex,
        transactionValue: asBigInt(json.transactionRequest.value) ?? 0n,
        bridge: json.bridge ?? json.toolDetails?.key ?? 'LI.FI',
        quotedAt: Date.now(),
        raw: json,
      };
    },
    async getStatus(quote, sourceTxHash): Promise<BridgeStatus> {
      const params = new URLSearchParams({ txHash: sourceTxHash, bridge: quote.bridge, fromChain: String(quote.fromChain.id), toChain: String(quote.toChain.id) });
      return getJson<BridgeStatus>(`${BASE_URL}/status?${params.toString()}`);
    },
  };
}
