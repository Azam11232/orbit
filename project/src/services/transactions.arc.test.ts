import { afterEach, describe, expect, it, vi } from 'vitest';
import { arcTestnet, base } from 'wagmi/chains';
import { getTransactionProviderForChain, isTransactionChainSupported } from '../hooks/useTransactions';
import {
  ARC_USDC_ADDRESS,
  createArcProvider,
  explorerTxUrl,
  formatTransactionDate,
} from './transactions';

const wallet = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const sentHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const receivedHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const knownPaymentHash = '0xebc0e4ae9b0566f56af408db893e26e817b6ba46c47973cbf5cdef5134ceafea';

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function transaction(hash: string, from: string, to: string, status: string, timestamp: string | null = '2026-09-12T15:57:06.000000Z') {
  return {
    hash,
    from: { hash: from },
    to: { hash: to, is_contract: false },
    value: '0',
    raw_input: '0x',
    status,
    timestamp,
    block_number: 123,
    gas_price: '28000000000',
    gas_used: '21000',
  };
}

function transfer(hash: string, from: string, to: string, contractAddress: string, logIndex = 0) {
  return {
    transaction_hash: hash,
    log_index: logIndex,
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        items: [
          transaction(sentHash, wallet, recipient, 'ok'),
          transaction(receivedHash, recipient, wallet, 'error'),
        ],
        next_page_params: { index: 9, block_number: 123 },
      }))
      .mockResolvedValueOnce(response({
        items: [
          transfer(sentHash, wallet, recipient, ARC_USDC_ADDRESS),
          transfer(receivedHash, recipient, wallet, ARC_USDC_ADDRESS),
          transfer(sentHash, wallet, recipient, '0x3333333333333333333333333333333333333333'),
        ],
        next_page_params: { index: 10, block_number: 123 },
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
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('follows ArcScan cursors and combines pages without duplicates while preserving order and normalization', async () => {
    const laterHash = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const transactionCursor = {
      index: 9,
      value: '100000000000000',
      hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      inserted_at: '2026-09-12T15:50:00.000000Z',
      block_number: 123,
      fee: '525000000000000',
    };
    const transferCursor = { index: 10, block_number: 123 };
    const txPageOne = [
      transaction(sentHash, wallet, recipient, 'ok', '2026-09-12T15:57:06.000000Z'),
      transaction(receivedHash, recipient, wallet, 'error', '2026-09-12T15:50:00.000000Z'),
    ];
    const transferPageOne = [
      transfer(sentHash, wallet, recipient, ARC_USDC_ADDRESS, 1),
      transfer(receivedHash, recipient, wallet, ARC_USDC_ADDRESS, 2),
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const isTransactionResource = url.pathname.endsWith('/transactions');

      if (isTransactionResource && url.searchParams.has('index')) {
        return response({
          items: [
            transaction(sentHash, wallet, recipient, 'error', '2026-09-12T15:57:06.000000Z'),
            transaction(laterHash, recipient, wallet, 'ok', '2026-09-12T14:00:00.000000Z'),
          ],
          next_page_params: null,
        });
      }
      if (isTransactionResource) {
        return response({ items: txPageOne, next_page_params: transactionCursor });
      }
      if (url.searchParams.has('index')) {
        return response({
          items: [
            transfer(sentHash, wallet, recipient, ARC_USDC_ADDRESS, 1),
            transfer(sentHash, wallet, recipient, ARC_USDC_ADDRESS, 3),
            transfer(receivedHash, recipient, wallet, ARC_USDC_ADDRESS, 2),
          ],
          next_page_params: null,
        });
      }
      return response({ items: transferPageOne, next_page_params: transferCursor });
    });

    const transactions = await createArcProvider().fetchTransactions({
      address: wallet,
      chainId: arcTestnet.id,
      limit: 20,
      fetchAllPages: true,
    });

    expect(transactions.map((item) => item.hash)).toEqual([sentHash, receivedHash, laterHash]);
    expect(transactions.map((item) => item.timestamp)).toEqual([
      new Date('2026-09-12T15:57:06Z').getTime(),
      new Date('2026-09-12T15:50:00Z').getTime(),
      new Date('2026-09-12T14:00:00Z').getTime(),
    ]);
    expect(transactions[0].status).toBe('success');
    expect(transactions[0].tokenTransfers).toHaveLength(2);
    expect(transactions[1].status).toBe('failed');
    expect(transactions[1].tokenTransfers).toHaveLength(1);

    const requestedUrls = fetchSpy.mock.calls.map(([input]) => new URL(String(input), 'http://localhost'));
    const transactionPageTwo = requestedUrls.find((url) =>
      url.pathname.endsWith('/transactions') && url.searchParams.has('index'),
    );
    const transferPageTwo = requestedUrls.find((url) =>
      url.pathname.endsWith('/token-transfers') && url.searchParams.has('index'),
    );
    expect(transactionPageTwo?.searchParams.get('value')).toBe(transactionCursor.value);
    expect(transactionPageTwo?.searchParams.get('hash')).toBe(transactionCursor.hash);
    expect(transactionPageTwo?.searchParams.get('inserted_at')).toBe(transactionCursor.inserted_at);
    expect(transactionPageTwo?.searchParams.get('block_number')).toBe(String(transactionCursor.block_number));
    expect(transactionPageTwo?.searchParams.get('fee')).toBe(transactionCursor.fee);
    expect(transferPageTwo?.searchParams.get('block_number')).toBe(String(transferCursor.block_number));
  });

  it('keeps successful and failed status when timestamps are missing', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        items: [
          transaction(sentHash, wallet, recipient, 'ok', null),
          transaction(receivedHash, recipient, wallet, 'error', null),
        ],
        next_page_params: null,
      }))
      .mockResolvedValueOnce(response({ items: [], next_page_params: null }));

    const transactions = await createArcProvider().fetchTransactions({
      address: wallet,
      chainId: arcTestnet.id,
      limit: 20,
    });

    expect(transactions.map(({ status, timestamp }) => ({ status, timestamp }))).toEqual([
      { status: 'success', timestamp: null },
      { status: 'failed', timestamp: null },
    ]);
    expect(transactions.map((item) => formatTransactionDate(item.timestamp))).toEqual([
      'Time unavailable',
      'Time unavailable',
    ]);
    expect(transactions.some((item) => item.status === 'pending')).toBe(false);
  });

  it('classifies an incoming token transfer by its transfer recipient', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ items: [transaction(sentHash, recipient, ARC_USDC_ADDRESS, 'ok')] }))
      .mockResolvedValueOnce(response({ items: [transfer(sentHash, recipient, wallet, ARC_USDC_ADDRESS)] }));

    const transactions = await createArcProvider().fetchTransactions({
      address: wallet,
      chainId: arcTestnet.id,
      limit: 20,
    });

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ hash: sentHash, category: 'Receive', status: 'success' });
  });

  it('recovers a transfer whose hash is missing from the recipient transaction list', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ items: [transaction(sentHash, wallet, recipient, 'ok')] }))
      .mockResolvedValueOnce(response({ items: [transfer(knownPaymentHash, recipient, wallet, ARC_USDC_ADDRESS)] }))
      .mockResolvedValueOnce(response({ items: [transaction(knownPaymentHash, recipient, ARC_USDC_ADDRESS, 'ok')] }));

    const transactions = await createArcProvider().fetchTransactions({
      address: wallet,
      chainId: arcTestnet.id,
      limit: 20,
    });

    expect(transactions.map((item) => item.hash)).toEqual([sentHash, knownPaymentHash]);
    expect(transactions[1]).toMatchObject({ category: 'Receive', status: 'success' });
    expect(transactions[1].tokenTransfers).toHaveLength(1);
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