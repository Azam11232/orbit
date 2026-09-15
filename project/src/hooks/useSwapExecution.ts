import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction } from 'wagmi';
import { base } from 'wagmi/chains';
import { type Address, type Hash } from 'viem';
import { createKyberSwapProvider } from '../services/swap/kyberswap';
import type { SwapQuote } from '../types/swap';

export type SwapExecutionStatus = 'idle' | 'preparing' | 'confirmation' | 'pending' | 'confirmed' | 'failed';
const provider = createKyberSwapProvider();
const QUOTE_MAX_AGE_MS = 15_000;
const RECEIPT_TIMEOUT_MS = 180_000;

export function useSwapExecution() {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { sendTransactionAsync } = useSendTransaction();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SwapExecutionStatus>('idle');
  const [transactionHash, setTransactionHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);

  const reset = () => {
    setStatus('idle');
    setTransactionHash(undefined);
    setError(null);
  };

  const execute = async (quote: SwapQuote, recipient: Address, slippageBps: number) => {
    setError(null);
    setStatus('idle');
    setTransactionHash(undefined);
    if (status === 'preparing' || status === 'confirmation' || status === 'pending') {
      throw new Error('A swap is already in progress');
    }
    if (!address || chainId !== base.id) throw new Error('Connect your wallet on Base before swapping');
    if (!publicClient) throw new Error('Base RPC is unavailable');
    if (Date.now() - quote.quotedAt > QUOTE_MAX_AGE_MS) throw new Error('Quote expired. Refresh the quote before swapping');
    if (!quote.routerAddress || !quote.routeSummary || quote.amountOut <= 0n) throw new Error('Quote data is incomplete');
    if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 100) throw new Error('Slippage must be between 0.1% and 1%');

    setStatus('preparing');
    try {
      const routerCode = await publicClient.getBytecode({ address: quote.routerAddress });
      if (!routerCode || routerCode === '0x') throw new Error('Quoted router is not a contract on Base');
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const transaction = await provider.buildTransaction({ quote, sender: address, recipient, slippageBps, deadline });
      if (transaction.routerAddress.toLowerCase() !== quote.routerAddress.toLowerCase() || transaction.to.toLowerCase() !== quote.routerAddress.toLowerCase()) throw new Error('Router address verification failed');
      if (!transaction.data || transaction.data === '0x') throw new Error('Swap calldata is empty');
      const expectedMinimum = quote.amountOut * BigInt(10_000 - slippageBps) / 10_000n;
      if (transaction.minimumReceived === null || transaction.minimumReceived < expectedMinimum) throw new Error('Provider minimum received could not be verified');
      if (quote.tokenIn.isNative && transaction.value !== quote.amountIn) throw new Error('Native ETH transaction value verification failed');
      setStatus('confirmation');
      const hash = await sendTransactionAsync({ to: transaction.to, data: transaction.data, value: transaction.value, chainId: base.id });
      setTransactionHash(hash);
      setStatus('pending');
      const receipt = await Promise.race([
        publicClient.waitForTransactionReceipt({ hash }),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Transaction confirmation timed out')), RECEIPT_TIMEOUT_MS)),
      ]);
      if (receipt.status !== 'success') throw new Error('Swap transaction reverted on Base');
      setStatus('confirmed');
      await queryClient.invalidateQueries();
    } catch (caughtError) {
      setStatus('failed');
      setError(caughtError instanceof Error ? caughtError : new Error('Swap failed'));
    }
  };

  return { execute, reset, status, transactionHash, error };
}
