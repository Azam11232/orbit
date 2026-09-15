import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';
import { encodeFunctionData, erc20Abi, type Hash, type Hex } from 'viem';
import type { BridgeQuote, BridgeStatus } from '../types/bridge';
import { cctpMessageTransmitterAbi } from '../services/bridge/cctp';
import { getOrbitNetwork } from '../data/networks';

export type BridgeExecutionStatus = 'idle' | 'wallet-confirmation' | 'source-pending' | 'source-confirmed' | 'bridging' | 'completed' | 'failed' | 'expired';
const QUOTE_MAX_AGE_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 180_000;

export function useBridgeExecution(quote: BridgeQuote | undefined) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: quote?.fromChain.id });
  const destinationClient = usePublicClient({ chainId: quote?.toChain.id });
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<BridgeExecutionStatus>('idle');
  const [sourceHash, setSourceHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);
  const reset = useCallback(() => {
    setStatus('idle');
    setSourceHash(undefined);
    setError(null);
    queryClient.removeQueries({ queryKey: ['bridge-status'] });
  }, [queryClient]);
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
      const gas = await publicClient.estimateGas({ account: address, to: quote.transactionTarget, data: quote.transactionData, value: quote.transactionValue });
      const gasPrice = await publicClient.getGasPrice();
      const nativeBalance = await publicClient.getBalance({ address });
      if (nativeBalance < gas * gasPrice) throw new Error(`Insufficient ${getOrbitNetwork(quote.fromChain.id)?.nativeCurrency.symbol ?? 'native gas'} balance for bridge transaction`);
      setStatus('wallet-confirmation');
      const hash = await sendTransactionAsync({ to: quote.transactionTarget, data: quote.transactionData, value: quote.transactionValue, chainId: quote.fromChain.id });
      setSourceHash(hash); setStatus('source-pending');
      const sourceReceipt = await Promise.race([publicClient.waitForTransactionReceipt({ hash }), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Source transaction confirmation timed out')), RECEIPT_TIMEOUT_MS))]);
      if (sourceReceipt.status !== 'success') throw new Error('Bridge source transaction reverted');
      setStatus('source-confirmed');
      await queryClient.invalidateQueries();
      return hash;
    } catch (caughtError) { setStatus('failed'); setError(caughtError instanceof Error ? caughtError : new Error('Bridge transaction failed')); return undefined; }
  };
  const complete = async (message: Hex | undefined, attestation: Hex | undefined) => {
    setError(null);
    if (status !== 'source-confirmed' || !address || !quote || !message || !attestation || !destinationClient) {
      const nextError = new Error('Circle attestation is not ready for destination mint');
      setStatus('failed');
      setError(nextError);
      return undefined;
    }
    const destination = getOrbitNetwork(quote.toChain.id);
    if (!destination) {
      const nextError = new Error('Destination network is not configured for CCTP');
      setStatus('failed');
      setError(nextError);
      return undefined;
    }
    try {
      setStatus('bridging');
      await switchChainAsync({ chainId: quote.toChain.id });
      const data = encodeFunctionData({ abi: cctpMessageTransmitterAbi, functionName: 'receiveMessage', args: [message, attestation] });
      const gas = await destinationClient.estimateGas({ account: address, to: destination.messageTransmitterV2, data, value: 0n });
      const gasPrice = await destinationClient.getGasPrice();
      const nativeBalance = await destinationClient.getBalance({ address });
      if (nativeBalance < gas * gasPrice) throw new Error(`Insufficient ${destination.nativeCurrency.symbol} balance for destination mint`);

      const balanceBefore = await destinationClient.readContract({
        address: destination.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }) as bigint;

      const hash = await sendTransactionAsync({ to: destination.messageTransmitterV2, data, value: 0n, chainId: quote.toChain.id });
      const destinationReceipt = await Promise.race([destinationClient.waitForTransactionReceipt({ hash }), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Destination transaction confirmation timed out')), RECEIPT_TIMEOUT_MS))]);
      if (destinationReceipt.status !== 'success') throw new Error('Bridge destination transaction reverted');

      const balanceAfter = await destinationClient.readContract({
        address: destination.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }) as bigint;

      if (balanceAfter <= balanceBefore) {
        const nextError = new Error('Destination mint not observed: canonical USDC balance did not increase');
        setStatus('failed');
        setError(nextError);
        return undefined;
      }

      if (sourceHash) {
        queryClient.setQueryData<BridgeStatus>(['bridge-status', quote.id, sourceHash.toString()], (current) => current ? ({
          ...current,
          receiving: { txHash: hash, chainId: quote.toChain.id },
        }) : ({
          status: 'PENDING',
          substatus: 'Destination receiveMessage submitted',
          receiving: { txHash: hash, chainId: quote.toChain.id },
        }));
      }

      setStatus('completed');
      await queryClient.invalidateQueries();
      return hash;
    } catch (caughtError) {
      setStatus('failed');
      setError(caughtError instanceof Error ? caughtError : new Error('Destination mint failed'));
      return undefined;
    }
  };
  return { execute, complete, reset, status, sourceHash, error };
}
