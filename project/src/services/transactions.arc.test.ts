import { afterEach, describe, expect, it, vi } from 'vitest';
import { arcTestnet, base } from 'wagmi/chains';
import { getTransactionProviderForChain, isTransactionChainSupported } from '../hooks/useTransactions';
import {
  ARC_USDC_ADDRESS,
  createArcProvider,
  explorerTxUrl,
} from './transactions';

const wallet = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const sentHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const receivedHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function transaction(hash: string, from: string, to: string, status: string) {
  return {
    hash,
    from: { hash: from },
    to: { hash: to, is_contract: false },
    value: '0',
    raw_input: '0x',
    status,
    timestamp: '2026-09-12T15:57:06.000000Z',
    block_number: 123,
    gas_price: '28000000000',
    gas_used: '21000',
  };
}

function transfer(hash: string, from: string, to: string, contractAddress: string) {
  return {
    transaction_hash: hash,
    from: { hash: from },
    to: { hash: to },
    token: { address_hash: contractAddress, decimals: '6', symbol: 'USDC' },
    total: { decimals: '6', value: '1250000' },
  };
}

describe('Arc activity provider', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('supports only Arc transaction sources', () => {
    expect(isTransactionChainSupported(base.id)).toBe(true);
    expect(isTransactionChainSupported(arcTestnet.id)).toBe(true);
    expect(isTransactionChainSupported(1)).toBe(false);
    expect(getTransactionProviderForChain(arcTestnet.id)).toBeDefined();
    expect(getTransactionProviderForChain(base.id)).toBeDefined();
  });

  it('parses real-shaped Arc transactions and only the official USDC transfers', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        items: [
          transaction(sentHash, wallet, recipient, 'ok'),
          transaction(receivedHash, recipient, wallet, 'error'),
        ],
      }))
      .mockResolvedValueOnce(response({
        items: [
          transfer(sentHash, wallet, recipient, ARC_USDC_ADDRESS),
          transfer(receivedHash, recipient, wallet, ARC_USDC_ADDRESS),
          transfer(sentHash, wallet, recipient, '0x3333333333333333333333333333333333333333'),
        ],
      }));

    const transactions = await createArcProvider().fetchTransactions({
      address: wallet,
      chainId: arcTestnet.id,
      limit: 20,
    });

    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      hash: sentHash,
      category: 'Send',
      status: 'success',
      nativeSymbol: 'USDC',
      blockNumber: 123,
    });
    expect(transactions[0].timestamp).toBe(new Date('2026-09-12T15:57:06Z').getTime());
    expect(transactions[0].tokenTransfers).toHaveLength(1);
    expect(transactions[0].tokenTransfers[0]).toMatchObject({
      symbol: 'USDC',
      amount: '1.25',
      decimals: 6,
      direction: 'sent',
      contractAddress: ARC_USDC_ADDRESS,
    });
    expect(transactions[1].category).toBe('Receive');
    expect(transactions[1].status).toBe('failed');
    expect(transactions[1].tokenTransfers[0].direction).toBe('received');
  });

  it('fails instead of treating an invalid Arc response as an empty history', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ items: [] }))
      .mockResolvedValueOnce(response({ items: null }));

    await expect(createArcProvider().fetchTransactions({
      address: wallet,
      chainId: arcTestnet.id,
      limit: 20,
    })).rejects.toThrow('invalid activity response');
  });

  it('uses the ArcScan transaction route', () => {
    expect(explorerTxUrl(sentHash, arcTestnet.id)).toBe(`https://testnet.arcscan.app/tx/${sentHash}`);
  });
});