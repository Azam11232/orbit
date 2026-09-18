import { describe, expect, it } from 'vitest';
import { arcTestnet } from 'wagmi/chains';
import { ARC_USDC } from '../data/tokens';
import {
  arcPaymentRequestUrl,
  arcPaymentRequestQrUri,
  createArcPaymentRequest,
  decodeArcPaymentLink,
  decodeArcPaymentRequest,
  encodeArcPaymentRequest,
  verifyArcPayment,
} from './arcPayment';
import type { ChainTransaction } from './transactions';

const recipient = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const sender = '0x2222222222222222222222222222222222222222';

function paymentTransaction(overrides: Partial<ChainTransaction> = {}): ChainTransaction {
  return {
    hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    from: sender,
    to: ARC_USDC.address,
    value: '0',
    timestamp: 1_700_000_000_000,
    status: 'success',
    category: 'Receive',
    blockNumber: 12,
    tokenTransfers: [{
      hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      symbol: 'USDC',
      contractAddress: ARC_USDC.address,
      amount: '1.25',
      decimals: 6,
      direction: 'received',
      rawAmount: '1250000',
      from: sender,
      to: recipient,
    }],
    ...overrides,
  };
}

describe('Arc payment requests', () => {
  it('encodes and decodes a deterministic request with exact raw amount', () => {
    const request = createArcPaymentRequest({ recipient, amount: '1.25', label: 'Orbit Coffee' });
    const decoded = decodeArcPaymentRequest(encodeArcPaymentRequest(request));
    expect(decoded).toEqual(request);
    expect(decoded.chainId).toBe(5042002);
    expect(decoded.token).toBe(ARC_USDC.address);
    expect(decoded.amountRaw).toBe('1250000');
  });

  it('keeps the QR payload equal to the shareable request payload', () => {
    const request = createArcPaymentRequest({ recipient, amount: '1' });
    const url = new URL(arcPaymentRequestUrl(request, 'https://orbit.example/app'));
    expect(decodeArcPaymentRequest(url.searchParams.get('arcPay') ?? '')).toEqual(request);
    expect(url.toString().length).toBeLessThan(180);
  });

  it('creates an ERC-681 token transfer QR payload', () => {
    const request = createArcPaymentRequest({ recipient, amount: '1.25' });
    expect(arcPaymentRequestQrUri(request)).toBe(
      `ethereum:${ARC_USDC.address}@${arcTestnet.id}/transfer?address=${recipient}&uint256=1250000`,
    );
  });

  it('round-trips a cancelled request link state', () => {
    const request = createArcPaymentRequest({ recipient, amount: '1' });
    const params = new URL(arcPaymentRequestUrl(request, 'https://orbit.example/app', 'cancelled')).searchParams;
    expect(decodeArcPaymentLink(params)).toEqual({ request, state: 'cancelled' });
    params.set('state', 'unknown');
    expect(() => decodeArcPaymentLink(params)).toThrow('state');
  });

  it('rejects invalid recipient, zero, negative, and over-precision amounts', () => {
    expect(() => createArcPaymentRequest({ recipient: 'bad', amount: '1' })).toThrow('recipient');
    expect(() => createArcPaymentRequest({ recipient, amount: '0' })).toThrow('greater than zero');
    expect(() => createArcPaymentRequest({ recipient, amount: '-1' })).toThrow();
    expect(() => createArcPaymentRequest({ recipient, amount: '1.0000001' })).toThrow('6 decimals');
  });

  it('rejects a tampered payload whose display amount has excess precision', () => {
    const request = createArcPaymentRequest({ recipient, amount: '1' });
    const encoded = btoa(JSON.stringify({ ...request, amount: '1.0000001' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    expect(() => decodeArcPaymentRequest(encoded)).toThrow('amount');
  });

  it('confirms only an Arc success with matching USDC recipient and amount', () => {
    const request = createArcPaymentRequest({ recipient, amount: '1.25' });
    expect(verifyArcPayment(request, [paymentTransaction()], arcTestnet.id)).toMatchObject({ status: 'confirmed' });
    expect(verifyArcPayment(request, [paymentTransaction({ status: 'pending' })], arcTestnet.id).status).toBe('detected');
    expect(verifyArcPayment(request, [paymentTransaction({ status: 'failed' })], arcTestnet.id).status).toBe('not-found');
    expect(verifyArcPayment(request, [paymentTransaction({ tokenTransfers: [{ ...paymentTransaction().tokenTransfers[0], rawAmount: '1000000' }] })], arcTestnet.id).status).toBe('not-found');
    expect(verifyArcPayment(request, [paymentTransaction({ tokenTransfers: [{ ...paymentTransaction().tokenTransfers[0], contractAddress: '0x3333333333333333333333333333333333333333' }] })], arcTestnet.id).status).toBe('not-found');
    expect(verifyArcPayment(request, [paymentTransaction()], 8453).status).toBe('unavailable');
  });

  it('returns every matching payment instead of collapsing duplicates', () => {
    const request = createArcPaymentRequest({ recipient, amount: '1.25' });
    const second = paymentTransaction({ hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const result = verifyArcPayment(request, [paymentTransaction(), second], arcTestnet.id);
    expect(result.status).toBe('confirmed');
    if (result.status === 'confirmed') expect(result.matches).toHaveLength(2);
  });
});