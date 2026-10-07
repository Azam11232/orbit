import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useSwitchChain } from 'wagmi';
import { formatUnits, parseUnits, type EIP1193Provider } from 'viem';
import { RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { ARC_EURC, ARC_USDC, ARC_SWAP_ASSETS, type BaseAssetConfig } from '../data/tokens';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useArcSwapExecution, useArcSwapQuote } from '../hooks/useArcSwap';
import { explorerTxUrl } from '../services/transactions';
import { getCurrentArcSwapQuote, isArcSwapQuoteReviewable } from '../services/swap/quoteState';
import type { ArcSwapSymbol } from '../types/swap';
import { Button, Card, Label, TokenIcon } from './ui';
import { TransactionSuccessScreen } from './TransactionSuccessScreen';

const ARC_CHAIN_ID = 5042002;
const QUOTE_MAX_AGE_MS = 30_000;

function assetFor(symbol: ArcSwapSymbol): BaseAssetConfig & { address: `0x${string}` } {
  return symbol === 'USDC' ? ARC_USDC : ARC_EURC;
}

function isUnsupportedRouteError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.includes('331001') || /no route available/i.test(current)) return true;
      continue;
    }
    if (!current || typeof current !== 'object' || visited.has(current)) continue;

    visited.add(current);
    const errorDetails = current as Record<string, unknown>;
    const name = errorDetails.name ?? (current instanceof Error ? current.name : undefined);
    const code = errorDetails.code;

    if (
      name === 'INPUT_UNSUPPORTED_ROUTE'
      || code === 1003
      || code === '1003'
      || code === 331001
      || code === '331001'
    ) {
      return true;
    }

    pending.push(errorDetails.message, errorDetails.cause, ...Object.values(errorDetails));
    if (current instanceof Error) pending.push(current.message);
  }

  return false;
}

export function ArcSwapPage() {
  const { address, chainId, connector, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const queryClient = useQueryClient();
  const [providerState, setProviderState] = useState<{
    connector: NonNullable<typeof connector>;
    provider: EIP1193Provider;
  }>();
  const [tokenIn, setTokenIn] = useState<ArcSwapSymbol>('USDC');
  const [tokenOut, setTokenOut] = useState<ArcSwapSymbol>('EURC');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(50);
  const [quoteUpdatedAt, setQuoteUpdatedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [showReview, setShowReview] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [mode, setMode] = useState<'token' | 'fx'>('token');
  const [completedAt, setCompletedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setProviderState(undefined);
    if (!connector) {
      return () => { active = false; };
    }
    void connector.getProvider().then((nextProvider) => {
      if (active && nextProvider) {
        setProviderState({ connector, provider: nextProvider as EIP1193Provider });
      }
    }).catch(() => {
      if (active) setProviderState(undefined);
    });
    return () => { active = false; };
  }, [connector]);

  const providerForCurrentConnector = providerState?.connector === connector
    ? providerState
    : undefined;
  const provider = providerForCurrentConnector?.provider;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const inputAsset = assetFor(tokenIn);
  const outputAsset = assetFor(tokenOut);
  const inputBalance = useTokenBalance(inputAsset, address, Boolean(isConnected && chainId === ARC_CHAIN_ID));
  const outputBalance = useTokenBalance(outputAsset, address, Boolean(isConnected && chainId === ARC_CHAIN_ID));
  const balance = inputBalance;

  let rawAmount: bigint | null = null;
  try {
    rawAmount = amount ? parseUnits(amount, inputAsset.decimals) : null;
  } catch {
    rawAmount = null;
  }

  const amountError = amount && rawAmount === null
    ? `Enter a valid amount with up to ${inputAsset.decimals} decimals.`
    : rawAmount !== null && rawAmount <= 0n
      ? 'Amount must be greater than zero.'
      : rawAmount !== null && rawAmount > balance.raw
        ? `Insufficient ${tokenIn} balance.`
        : null;
  const amountForQuote = !amountError && rawAmount !== null ? amount : '';
  const quoteQuery = useArcSwapQuote({ provider, providerConnector: providerForCurrentConnector?.connector, tokenIn, tokenOut, amountIn: amountForQuote, slippageBps });
  useEffect(() => {
    if (quoteQuery.quote) setQuoteUpdatedAt(Date.now());
  }, [quoteQuery.quote]);
  const isNoRouteError = isUnsupportedRouteError(quoteQuery.error);
  const availableQuote = getCurrentArcSwapQuote(quoteQuery, isNoRouteError);
  const quoteExpiresAt = quoteUpdatedAt + QUOTE_MAX_AGE_MS;
  const quoteFresh = Boolean(availableQuote && quoteUpdatedAt > 0 && now < quoteExpiresAt);
  const execution = useArcSwapExecution();
  const resetExecution = execution.reset;
  useEffect(() => {
    if (execution.state === 'confirmed' && execution.transactionHash) {
      setCompletedAt((current) => current ?? Date.now());
    } else if (execution.state !== 'confirmed') {
      setCompletedAt(null);
    }
  }, [execution.state, execution.transactionHash]);
  useEffect(() => {
    resetExecution();
    setShowReview(false);
    setValidationError(null);
  }, [tokenIn, tokenOut, amount, resetExecution]);
  const canReview = Boolean(isConnected && chainId === ARC_CHAIN_ID && provider && rawAmount && rawAmount > 0n && !amountError && isArcSwapQuoteReviewable(quoteQuery, isNoRouteError, quoteFresh));

  const changeDirection = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmount('');
    setShowReview(false);
    setValidationError(null);
  };

  const execute = () => {
    if (isNoRouteError || quoteQuery.isError || quoteQuery.isFetching || !quoteQuery.isSuccess || !availableQuote || !quoteFresh || !amountForQuote) {
      setValidationError('Swap quote expired. Request a fresh quote.');
      return;
    }
    setValidationError(null);
    void execution.execute({
      provider,
      tokenIn,
      tokenOut,
      amountIn: amountForQuote,
      slippageBps,
      quoteAmountIn: availableQuote.amountIn,
      quoteExpiresAt,
      quoteIsCurrent: !quoteQuery.isError && !quoteQuery.isFetching && quoteQuery.isSuccess && Boolean(availableQuote),
    }).then(() => {
      void Promise.all([inputBalance.refetch(), outputBalance.refetch()]);
      void queryClient.invalidateQueries({ queryKey: ['balance'] });
      void queryClient.invalidateQueries({ queryKey: ['prices'] });
    });
  };

  const resetSwap = () => {
    resetExecution();
    setShowReview(false);
    setValidationError(null);
  };

  const quoteErrorText = isNoRouteError
    ? 'No swap route is currently available for this pair on Arc Testnet. Please try again later.'
    : quoteQuery.isError
    ? 'Unable to get a swap quote right now. Please try again.'
    : null;

  const statusText = isNoRouteError
    ? quoteErrorText
    : validationError
      ?? execution.error?.message
      ?? amountError
      ?? (chainId !== ARC_CHAIN_ID && isConnected ? 'Switch to Arc Testnet before swapping.' : null)
      ?? quoteErrorText
      ?? (!availableQuote && amountForQuote ? 'Requesting a live Arc Testnet quote...' : null)
      ?? (availableQuote && !quoteFresh ? 'Swap quote expired. Request a fresh quote.' : null);

  if (execution.state === 'confirmed' && execution.transactionHash && availableQuote) {
    return (
      <TransactionSuccessScreen
        title="Swap Successful!"
        description="Your token swap was successfully confirmed on Arc Testnet."
        amountLabel="Amount sold"
        amount={availableQuote.amountIn}
        token={inputAsset}
        secondaryAmount={{ label: 'Amount received', amount: availableQuote.estimatedOutput.amount, token: outputAsset }}
        networks={[{ label: 'Network', network: { id: ARC_CHAIN_ID, name: 'Arc Testnet' } }]}
        transactionHash={execution.transactionHash}
        successChimeKey={`swap:${execution.transactionHash}`}
        explorerUrl={explorerTxUrl(execution.transactionHash, ARC_CHAIN_ID)}
        gasFee="Unavailable"
        completedAt={completedAt ?? Date.now()}
        primaryLabel="Back to Swap"
        onBack={resetSwap}
        onPrimary={resetSwap}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="page-shell flex flex-wrap items-end justify-between gap-4 rounded-2xl px-4 py-3 sm:px-5">
        <div>
          <Label>Move / Swap / Arc Testnet</Label>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-white">Swap stablecoins on Arc.</h1>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-400">
          <span className="h-2 w-2 rounded-full bg-cyan-300" />
          Arc Testnet
        </div>
      </div>

      <div className="inline-flex rounded-xl border border-white/10 bg-white/[.03] p-1" role="tablist" aria-label="Swap mode">
        <button type="button" role="tab" aria-selected={mode === 'token'} onClick={() => setMode('token')} className={`rounded-lg px-4 py-2 text-xs font-bold transition ${mode === 'token' ? 'bg-cyan-300/15 text-cyan-100' : 'text-slate-400 hover:text-white'}`}>Token Swap</button>
        <button type="button" role="tab" aria-selected={mode === 'fx'} onClick={() => setMode('fx')} className={`rounded-lg px-4 py-2 text-xs font-bold transition ${mode === 'fx' ? 'bg-cyan-300/15 text-cyan-100' : 'text-slate-400 hover:text-white'}`}>Stablecoin FX</button>
      </div>

      {mode === 'fx' ? <StablecoinFxUnavailable /> : null}

      {mode === 'token' && (!isConnected ? (
        <Card className="flex flex-col items-center p-10 text-center" glow>
          <Wallet size={28} className="text-cyan-300" />
          <h2 className="mt-4 text-xl font-bold">Connect your wallet</h2>
          <p className="mt-2 text-sm text-slate-400">Connect an Arc Testnet wallet to request a live quote.</p>
        </Card>
      ) : chainId !== ARC_CHAIN_ID ? (
        <Card className="flex flex-col items-center p-10 text-center" glow>
          <ShieldCheck size={28} className="text-amber-300" />
          <h2 className="mt-4 text-xl font-bold">Switch to Arc Testnet</h2>
          <p className="mt-2 text-sm text-slate-400">Circle Swap supports this flow on Arc Testnet.</p>
          <Button className="mt-5" variant="secondary" onClick={() => switchChain({ chainId: ARC_CHAIN_ID })} disabled={isSwitching}>
            {isSwitching ? 'Switching...' : 'Switch to Arc Testnet'}
          </Button>
        </Card>
      ) : (
        <Card className="p-5" glow>
          <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-end">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-slate-400">From</span>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.04] p-3">
                <TokenIcon symbol={tokenIn} color={inputAsset.color} />
                <select value={tokenIn} onChange={(event) => { setTokenIn(event.target.value as ArcSwapSymbol); setAmount(''); setShowReview(false); }} className="min-w-0 flex-1 bg-transparent font-bold text-white outline-none">
                  {ARC_SWAP_ASSETS.map((asset) => <option key={asset.symbol} value={asset.symbol} className="bg-[#101725]">{asset.symbol}</option>)}
                </select>
              </div>
              <span className="mt-2 block font-mono text-[10px] text-slate-500">Balance {balance.isLoading ? '...' : formatUnits(balance.raw, inputAsset.decimals)} {tokenIn}</span>
            </label>
            <button type="button" onClick={changeDirection} aria-label="Swap direction" className="mx-auto rounded-xl border border-white/10 bg-[#141d2e] px-3 py-2 text-cyan-300">⇄</button>
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-slate-400">To</span>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.04] p-3">
                <TokenIcon symbol={tokenOut} color={outputAsset.color} />
                <select value={tokenOut} onChange={(event) => { setTokenOut(event.target.value as ArcSwapSymbol); setAmount(''); setShowReview(false); }} className="min-w-0 flex-1 bg-transparent font-bold text-white outline-none">
                  {ARC_SWAP_ASSETS.map((asset) => <option key={asset.symbol} value={asset.symbol} disabled={asset.symbol === tokenIn} className="bg-[#101725]">{asset.symbol}</option>)}
                </select>
              </div>
              <span className="mt-2 block font-mono text-[10px] text-slate-500">Balance {outputBalance.isLoading ? '...' : formatUnits(outputBalance.raw, outputAsset.decimals)} {tokenOut}</span>
            </label>
          </div>

          <label className="mt-5 block">
            <span className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-400"><span>Amount</span><button type="button" onClick={() => setAmount(formatUnits(balance.raw, inputAsset.decimals))} className="font-mono text-[10px] text-cyan-300">MAX</button></span>
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={amount} onChange={(event) => { setAmount(event.target.value); setShowReview(false); }} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-2xl font-bold text-white outline-none placeholder:text-slate-600" /><span className="font-mono text-xs text-slate-500">{tokenIn}</span></div>
          </label>

          <div className="mt-5 space-y-3 rounded-xl border border-white/10 bg-white/[.03] p-4 text-xs">
            <div className="flex justify-between"><span className="text-slate-500">Expected output</span><span className="font-mono text-slate-200">{isNoRouteError ? 'Unavailable' : quoteQuery.isLoading ? 'Loading...' : availableQuote?.estimatedOutput.amount ?? 'Unavailable'} {tokenOut}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Minimum received</span><span className="font-mono text-slate-200">{availableQuote?.stopLimit.amount ?? 'Unavailable'} {tokenOut}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Fees</span><span className="font-mono text-slate-200">{isNoRouteError ? 'Unavailable' : availableQuote?.fees?.length ? availableQuote.fees.map((fee) => `${fee.amount} ${fee.token}`).join(', ') : 'Not provided by route'}</span></div>
            <div className="flex items-center justify-between"><span className="text-slate-500">Slippage</span><select value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))} className="rounded border border-white/10 bg-[#101725] px-2 py-1 font-mono text-[10px] text-slate-300"><option value={10}>0.1%</option><option value={50}>0.5%</option><option value={100}>1%</option></select></div>
            <div className="flex justify-between"><span className="text-slate-500">Quote expires</span><span className="font-mono text-slate-200">{quoteFresh ? `${Math.ceil((quoteExpiresAt - now) / 1000)}s` : 'Unavailable'}</span></div>
          </div>

          {statusText && <p className={`mt-4 text-xs ${isNoRouteError || quoteQuery.isError || execution.error || validationError || amountError ? 'text-rose-300' : 'text-slate-400'}`}>{statusText}</p>}
          <Button className="mt-5 w-full" onClick={() => setShowReview(true)} disabled={!canReview || execution.state === 'pending'} icon>{execution.state === 'pending' ? 'Swap pending...' : execution.state === 'confirmed' ? 'Swap confirmed' : 'Review Swap'}</Button>
          {showReview && availableQuote && quoteFresh && <div className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4 text-xs"><Label>Final confirmation</Label><div className="mt-3 space-y-2"><div className="flex justify-between"><span className="text-slate-500">Route</span><span>{tokenIn} → {tokenOut}</span></div><div className="flex justify-between"><span className="text-slate-500">Network</span><span>Arc Testnet</span></div><div className="flex justify-between"><span className="text-slate-500">Minimum received</span><span>{availableQuote.stopLimit.amount} {tokenOut}</span></div></div><div className="mt-4 flex gap-2"><Button variant="secondary" className="flex-1" onClick={() => setShowReview(false)}>Cancel</Button><Button className="flex-1" onClick={execute} disabled={isNoRouteError || execution.state === 'pending'}>Confirm Swap</Button></div></div>}
          {execution.transactionHash && <p className="mt-3 text-xs text-emerald-300">Transaction: <a className="underline" href={explorerTxUrl(execution.transactionHash, ARC_CHAIN_ID)} target="_blank" rel="noopener noreferrer">{execution.transactionHash.slice(0, 10)}...{execution.transactionHash.slice(-8)}</a></p>}
          {(execution.state === 'failed' || isNoRouteError) && <Button variant="secondary" className="mt-3 w-full" onClick={() => { setShowReview(false); void quoteQuery.refetch(); }}><RefreshCw size={14} />Request fresh quote</Button>}
          <p className="mt-5 text-[10px] leading-4 text-slate-500">Circle Swap supports USDC, EURC, and cirBTC on Arc Testnet. cirBTC remains hidden until its current official Arc Testnet contract address is verified by ORBIT.</p>
        </Card>
      ))}
    </div>
  );
}

function StablecoinFxUnavailable() {
  return (
    <Card className="p-6" glow>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Label>Stablecoin FX / Arc Testnet</Label>
          <h2 className="mt-2 text-2xl font-bold text-white">USDC to EURC</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">StableFX is Circle's institutional RFQ engine. It sources quotes from approved liquidity providers and settles through Arc escrow.</p>
        </div>
        <span className="rounded-full border border-amber-300/20 bg-amber-300/[.06] px-3 py-1 text-[10px] font-semibold uppercase tracking-[.12em] text-amber-200">Unavailable</span>
      </div>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <FxField label="You pay" value="USDC" />
        <FxField label="You receive" value="EURC" />
        <FxField label="Estimated receive" value="Unavailable" />
        <FxField label="Rate" value="Unavailable" />
        <FxField label="Minimum received" value="Unavailable" />
        <FxField label="Fee" value="Unavailable" />
      </div>
      <div className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/[.05] p-4 text-sm text-amber-100">
        <p className="font-semibold">StableFX cannot be executed from this browser-only integration.</p>
        <p className="mt-2 text-xs leading-5 text-amber-100/80">Circle requires a StableFX API key issued through a Circle representative, authenticated RFQ/trade requests, Permit2 allowance, and multiple EIP-712 signatures. ORBIT does not expose API secrets, so no live quote, rate, fee, or Review FX action is shown.</p>
      </div>
      <Button className="mt-5 w-full" disabled>Review FX unavailable</Button>
      <p className="mt-4 text-[10px] leading-4 text-slate-500">Verified Arc Testnet contracts: StableFX escrow 0xd682...2E10 and Permit2 0x0000...78BA3. Contract addresses are not sufficient to create a quote without the authenticated StableFX service.</p>
    </Card>
  );
}

function FxField({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/10 bg-white/[.03] p-4"><span className="text-xs font-semibold text-slate-500">{label}</span><p className="mt-2 font-mono text-sm text-slate-200">{value}</p></div>;
}
