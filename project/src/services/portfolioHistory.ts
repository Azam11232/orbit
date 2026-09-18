import type { ChainTransaction } from './transactions';

export interface BalanceHistoryPoint {
  time: number;
  balance: bigint;
  isCurrent?: boolean;
}

interface BalanceHistoryInput {
  transactions: ChainTransaction[];
  walletAddress: string;
  currentBalance: bigint;
  tokenAddress: string;
}

export function reconstructTokenBalanceHistory({
  transactions,
  walletAddress,
  currentBalance,
  tokenAddress,
}: BalanceHistoryInput): BalanceHistoryPoint[] {
  const wallet = walletAddress.toLowerCase();
  const token = tokenAddress.toLowerCase();
  const uniqueTransactions = new Map<string, ChainTransaction>();

  for (const transaction of transactions) {
    if (transaction.status !== 'success' || transaction.timestamp === null) continue;
    const hash = transaction.hash.toLowerCase();
    if (!hash || uniqueTransactions.has(hash)) continue;
    uniqueTransactions.set(hash, transaction);
  }

  const events = [...uniqueTransactions.values()]
    .map((transaction) => {
      const delta = transaction.tokenTransfers
        .filter((transfer) => transfer.contractAddress.toLowerCase() === token)
        .reduce((total, transfer) => {
          const amount = BigInt(transfer.rawAmount);
          return total + (transfer.direction === 'received' && transfer.to?.toLowerCase() === wallet ? amount : transfer.direction === 'sent' && transfer.from?.toLowerCase() === wallet ? -amount : 0n);
        }, 0n);

      return { time: transaction.timestamp as number, delta };
    })
    .filter((event) => event.delta !== 0n)
    .sort((left, right) => left.time - right.time);

  if (events.length === 0) return [];

  const balanceBeforeHistory = currentBalance - events.reduce((total, event) => total + event.delta, 0n);
  let balance = balanceBeforeHistory;
  const points: BalanceHistoryPoint[] = [];

  for (const event of events) {
    balance += event.delta;
    points.push({ time: event.time, balance });
  }

  return points;
}
