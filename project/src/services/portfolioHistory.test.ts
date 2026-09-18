import { describe, expect, it } from 'vitest';
import { reconstructTokenBalanceHistory } from './portfolioHistory';
import type { ChainTransaction } from './transactions';

const wallet = '0x1111111111111111111111111111111111111111';
const sender = '0x2222222222222222222222222222222222222222';
const tokenAddress = '0x3600000000000000000000000000000000000000';

function transaction(overrides: Partial<ChainTransaction>): ChainTransaction {
  return {
    hash: '0xdefault',
    from: sender,
    to: wallet,
    value: '0.000000',
    timestamp: 0,
    status: 'success',
    category: 'Receive',
    blockNumber: 1,
    tokenTransfers: [],
    ...overrides,
  };
}

function transfer(rawAmount: string, direction: 'sent' | 'received') {
  return {
    hash: '0xtransfer',
    symbol: 'USDC',
    contractAddress: tokenAddress,
    amount: String(Number(rawAmount) / 1_000_000),
    decimals: 6,
    direction,
    rawAmount,
    from: direction === 'sent' ? wallet : sender,
    to: direction === 'sent' ? sender : wallet,
  };
}

describe('reconstructTokenBalanceHistory', () => {
  it('reconstructs chronological confirmed balance changes and excludes invalid events', () => {
    const history = reconstructTokenBalanceHistory({
      walletAddress: wallet,
      tokenAddress,
      currentBalance: 14_000_000n,
      transactions: [
        transaction({ hash: '0xday4', timestamp: 4_000, tokenTransfers: [transfer('2000000', 'received')] }),
        transaction({ hash: '0xday2', timestamp: 2_000, category: 'Send', from: wallet, to: sender, tokenTransfers: [transfer('3000000', 'sent')] }),
        transaction({ hash: '0xday1', timestamp: 1_000, tokenTransfers: [transfer('5000000', 'received')] }),
        transaction({ hash: '0xfailed', timestamp: 3_000, status: 'failed', tokenTransfers: [transfer('9000000', 'received')] }),
        transaction({ hash: '0xpending', timestamp: 3_500, status: 'pending', tokenTransfers: [transfer('9000000', 'received')] }),
        transaction({ hash: '0xday2', timestamp: 2_000, category: 'Send', from: wallet, to: sender, tokenTransfers: [transfer('3000000', 'sent')] }),
        transaction({ hash: '0xmissing-time', timestamp: null, tokenTransfers: [transfer('9000000', 'received')] }),
      ],
    });

    expect(history).toEqual([
      { time: 1_000, balance: 15_000_000n },
      { time: 2_000, balance: 12_000_000n },
      { time: 4_000, balance: 14_000_000n },
    ]);
    expect(history[history.length - 1]?.balance).toBe(14_000_000n);
  });
});
