import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import type { EIP1193Provider } from 'viem';
import { estimateArcSwap, executeArcSwap } from '../services/swap/arcSwap';
import type { ArcSwapSymbol } from '../types/swap';

export function useArcSwapQuote({
  provider,
  tokenIn,
  tokenOut,
  amountIn,
  slippageBps,
}: {
  provider?: EIP1193Provider;
  tokenIn: ArcSwapSymbol;
  tokenOut: ArcSwapSymbol;
  amountIn: string;
  slippageBps: number;
}) {
  const { address, chainId } = useAccount();
  const enabled = Boolean(provider && address && chainId === 5042002 && amountIn && tokenIn !== tokenOut);
  const query = useQuery({
    queryKey: ['arc-swap-quote', address, tokenIn, tokenOut, amountIn, slippageBps],
    queryFn: () => estimateArcSwap({
      provider: provider as EIP1193Provider,
      walletAddress: address as `0x${string}`,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps,
    }),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  return {
    quote: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useArcSwapExecution() {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: 5042002 });
  const [state, setState] = React.useState<'idle' | 'pending' | 'confirmed' | 'failed'>('idle');
  const [transactionHash, setTransactionHash] = React.useState<string>();
  const [error, setError] = React.useState<Error | null>(null);
  const inFlight = React.useRef(false);
  const reset = React.useCallback(() => {
    if (inFlight.current) return;
    setState('idle');
    setTransactionHash(undefined);
    setError(null);
  }, []);

  const execute = async ({
    provider,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    quoteAmountIn,
    quoteExpiresAt,
  }: {
    provider?: EIP1193Provider;
    tokenIn: ArcSwapSymbol;
    tokenOut: ArcSwapSymbol;
    amountIn: string;
    slippageBps: number;
    quoteAmountIn: string;
    quoteExpiresAt: number;
  }) => {
    if (inFlight.current || state === 'pending') return;
    if (!provider || !address || chainId !== 5042002) {
      setError(new Error('Connect your wallet on Arc Testnet before swapping'));
      setState('failed');
      return;
    }
    if (!amountIn || amountIn !== quoteAmountIn || Date.now() >= quoteExpiresAt) {
      setError(new Error('Swap quote expired. Request a fresh quote'));
      setState('failed');
      return;
    }

    inFlight.current = true;
    setState('pending');
    setError(null);
    setTransactionHash(undefined);
    try {
      const result = await executeArcSwap({
        provider,
        walletAddress: address,
        tokenIn,
        tokenOut,
        amountIn,
        slippageBps,
      });
      if (!result.txHash) throw new Error('Arc Swap did not return a transaction hash');
      if (!publicClient) throw new Error('Arc Testnet RPC is unavailable for receipt confirmation');
      const receipt = await publicClient.waitForTransactionReceipt({ hash: result.txHash as `0x${string}` });
      if (receipt.status !== 'success') throw new Error('Arc Swap transaction reverted on Arc Testnet');
      setTransactionHash(result.txHash);
      setState('confirmed');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError : new Error('Arc Swap failed'));
      setState('failed');
    } finally {
      inFlight.current = false;
    }
  };

  return { execute, reset, state, transactionHash, error };
}
