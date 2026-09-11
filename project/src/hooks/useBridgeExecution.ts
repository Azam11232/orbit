import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction } from 'wagmi';
import { erc20Abi, type Hash } from 'viem';
import type { BridgeQuote } from '../types/bridge';

export type BridgeExecutionStatus = 'idle' | 'wallet-confirmation' | 'source-pending' | 'source-confirmed' | 'bridging' | 'completed' | 'failed' | 'expired';
const QUOTE_MAX_AGE_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 180_000;

export function useBridgeExecution(quote: BridgeQuote | undefined) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: quote?.fromChain.id });
  const { sendTransactionAsync } = useSendTransaction();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<BridgeExecutionStatus>('idle');
  const [sourceHash, setSourceHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);
  const execute = async () => {
    setError(null);
    if (status === 'wallet-confirmation' || status === 'source-pending' || status === 'source-confirmed' || status === 'bridging') {
      const nextError = new Error('A bridge transaction is already in progress');
      setStatus('failed');
      setError(nextError);
      return;
    }
    if (!quote || !address || !publicClient) { const nextError = new Error('Bridge quote or source RPC is unavailable'); setStatus('failed'); setError(nextError); return; }
    if (chainId !== quote.fromChain.id) { const nextError = new Error(`Switch to ${quote.fromChain.name} before bridging`); setStatus('failed'); setError(nextError); return; }
    if (Date.now() - quote.quotedAt > QUOTE_MAX_AGE_MS) { const nextError = new Error('Bridge quote expired. Refresh the quote'); setStatus('expired'); setError(nextError); return; }
    if (!quote.transactionTarget || !quote.transactionData || quote.transactionData === '0x') { const nextError = new Error('Bridge transaction data is incomplete'); setStatus('failed'); setError(nextError); return; }
    const currentBalance = quote.fromToken.isNative ? await publicClient.getBalance({ address }) : await publicClient.readContract({ address: quote.fromToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    if (currentBalance < quote.fromAmount) { const nextError = new Error('Insufficient source-chain balance'); setStatus('failed'); setError(nextError); return; }
    const code = await publicClient.getBytecode({ address: quote.transactionTarget });
    if (!code || code === '0x') { const nextError = new Error('Bridge transaction target is not a contract on the source chain'); setStatus('failed'); setError(nextError); return; }
    if (quote.fromToken.isNative && quote.transactionValue !== quote.fromAmount) { const nextError = new Error('Bridge value does not match the quoted amount'); setStatus('failed'); setError(nextError); return; }
    try {
      setStatus('wallet-confirmation');
      const hash = await sendTransactionAsync({ to: quote.transactionTarget, data: quote.transactionData, value: quote.transactionValue, chainId: quote.fromChain.id });
      setSourceHash(hash); setStatus('source-pending');
      await Promise.race([publicClient.waitForTransactionReceipt({ hash }), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Source transaction confirmation timed out')), RECEIPT_TIMEOUT_MS))]);
      setStatus('source-confirmed');
      await queryClient.invalidateQueries();
      return hash;
    } catch (caughtError) { setStatus('failed'); setError(caughtError instanceof Error ? caughtError : new Error('Bridge transaction failed')); return undefined; }
  };
  return { execute, status, sourceHash, error };
}
