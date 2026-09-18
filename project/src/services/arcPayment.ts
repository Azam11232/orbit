import { formatUnits, isAddress, parseUnits, type Address } from 'viem';
import { arcTestnet } from 'wagmi/chains';
import { ARC_USDC } from '../data/tokens';
import type { ChainTransaction } from './transactions';

export const ARC_PAYMENT_VERSION = 1 as const;

export interface ArcPaymentRequest {
  version: typeof ARC_PAYMENT_VERSION;
  chainId: typeof arcTestnet.id;
  token: Address;
  recipient: Address;
  amountRaw: string;
  amount: string;
  label?: string;
}

export type ArcPaymentRequestState = 'active' | 'cancelled';

export interface ArcPaymentLink {
  request: ArcPaymentRequest;
  state: ArcPaymentRequestState;
}

export type ArcPaymentVerification =
  | { status: 'confirmed'; matches: ChainTransaction[] }
  | { status: 'detected'; matches: ChainTransaction[] }
  | { status: 'not-found'; matches: [] }
  | { status: 'awaiting'; matches: [] }
  | { status: 'unavailable'; matches: []; reason: string };

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function assertArcRequestShape(value: unknown): ArcPaymentRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid Arc payment request');
  const candidate = value as Partial<ArcPaymentRequest>;
  if (candidate.version !== ARC_PAYMENT_VERSION || candidate.chainId !== arcTestnet.id) throw new Error('Arc Testnet payment request required');
  if (typeof candidate.token !== 'string' || candidate.token.toLowerCase() !== ARC_USDC.address.toLowerCase()) throw new Error('Unsupported Arc payment token');
  if (typeof candidate.recipient !== 'string' || !isAddress(candidate.recipient)) throw new Error('Invalid payment recipient');
  if (typeof candidate.amountRaw !== 'string' || !/^\d+$/.test(candidate.amountRaw) || BigInt(candidate.amountRaw) <= 0n) throw new Error('Invalid payment amount');
  if (typeof candidate.amount !== 'string' || !/^\d+(?:\.\d{0,6})?$/.test(candidate.amount.trim()) || parseUnits(candidate.amount, ARC_USDC.decimals) !== BigInt(candidate.amountRaw)) throw new Error('Payment amount does not match its raw value');
  if (candidate.label !== undefined && (typeof candidate.label !== 'string' || candidate.label.length > 120)) throw new Error('Invalid payment label');

  return {
    version: ARC_PAYMENT_VERSION,
    chainId: arcTestnet.id,
    token: candidate.token as Address,
    recipient: candidate.recipient as Address,
    amountRaw: candidate.amountRaw,
    amount: candidate.amount,
    ...(candidate.label ? { label: candidate.label } : {}),
  };
}

export function createArcPaymentRequest({ recipient, amount, label }: { recipient: string; amount: string; label?: string }): ArcPaymentRequest {
  if (!isAddress(recipient)) throw new Error('Enter a valid payment recipient address');
  if (!/^\d+(?:\.\d{0,6})?$/.test(amount.trim())) throw new Error('Enter a valid USDC amount with up to 6 decimals');
  let amountRaw: bigint;
  try {
    amountRaw = parseUnits(amount, ARC_USDC.decimals);
  } catch {
    throw new Error('Enter a valid USDC amount with up to 6 decimals');
  }
  if (amountRaw <= 0n) throw new Error('Payment amount must be greater than zero');
  return assertArcRequestShape({
    version: ARC_PAYMENT_VERSION,
    chainId: arcTestnet.id,
    token: ARC_USDC.address,
    recipient,
    amountRaw: amountRaw.toString(),
    amount: formatUnits(amountRaw, ARC_USDC.decimals),
    label: label?.trim() || undefined,
  });
}

export function encodeArcPaymentRequest(request: ArcPaymentRequest): string {
  const validated = assertArcRequestShape(request);
  return [
    '1',
    validated.chainId,
    validated.token,
    validated.recipient,
    validated.amountRaw,
    validated.label ? encodeURIComponent(validated.label).replace(/\./g, '%2E') : '',
  ].join('.');
}

export function decodeArcPaymentRequest(encoded: string): ArcPaymentRequest {
  try {
    if (encoded.startsWith('1.')) {
      const [version, chainId, token, recipient, amountRaw, encodedLabel = ''] = encoded.split('.');
      const label = encodedLabel ? decodeURIComponent(encodedLabel) : undefined;
      return assertArcRequestShape({
        version: Number(version),
        chainId: Number(chainId),
        token,
        recipient,
        amountRaw,
        amount: formatUnits(BigInt(amountRaw), ARC_USDC.decimals),
        label,
      });
    }
    return assertArcRequestShape(JSON.parse(fromBase64Url(encoded)));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid Arc payment request');
  }
}

export function decodeArcPaymentLink(params: URLSearchParams): ArcPaymentLink {
  const encoded = params.get('arcPay');
  if (!encoded) throw new Error('Invalid Arc payment request');
  const state = params.get('state');
  if (state !== null && state !== 'active' && state !== 'cancelled') throw new Error('Invalid Arc payment request state');
  return {
    request: decodeArcPaymentRequest(encoded),
    state: state === 'cancelled' ? 'cancelled' : 'active',
  };
}

export function arcPaymentRequestUrl(request: ArcPaymentRequest, origin = typeof window === 'undefined' ? '' : window.location.origin, state?: ArcPaymentRequestState): string {
  const url = new URL(origin || 'https://orbit.local');
  url.searchParams.set('arcPay', encodeArcPaymentRequest(request));
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

export function arcPaymentRequestQrUri(request: ArcPaymentRequest): string {
  const validated = assertArcRequestShape(request);
  return `ethereum:${validated.token}@${validated.chainId}/transfer?address=${validated.recipient}&uint256=${validated.amountRaw}`;
}

export function findMatchingArcPayments(
  request: ArcPaymentRequest,
  transactions: ChainTransaction[],
  chainId: number,
): ChainTransaction[] {
  if (chainId !== arcTestnet.id) return [];
  return transactions.filter((transaction) => transaction.status !== 'failed' && transaction.tokenTransfers.some((transfer) => (
    transfer.contractAddress.toLowerCase() === ARC_USDC.address.toLowerCase()
      && transfer.rawAmount === request.amountRaw
      && transfer.direction === 'received'
      && transfer.to?.toLowerCase() === request.recipient.toLowerCase()
  )));
}

export function verifyArcPayment(
  request: ArcPaymentRequest,
  transactions: ChainTransaction[],
  chainId: number,
): ArcPaymentVerification {
  if (chainId !== arcTestnet.id) return { status: 'unavailable', matches: [], reason: 'Wrong chain' };
  const matches = findMatchingArcPayments(request, transactions, chainId);
  if (matches.length === 0) return { status: 'not-found', matches: [] };
  return matches.some((transaction) => transaction.status === 'success')
    ? { status: 'confirmed', matches }
    : { status: 'detected', matches };
}