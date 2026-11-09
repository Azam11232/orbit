import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useSwitchChain } from 'wagmi';
import { formatUnits, parseUnits, type EIP1193Provider } from 'viem';
import type { SwapEstimate } from '@circle-fin/swap-kit';
import { RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { ARC_EURC, ARC_USDC, ARC_SWAP_ASSETS, type BaseAssetConfig } from '../data/tokens';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useArcSwapExecution, useArcSwapQuote } from '../hooks/useArcSwap';
import {
  dismissArcSwapSuccess,
  createArcSwapSuccessPopupActions,
  getArcSwapCompletionTransition,
  isArcSwapSuccessDismissed,
  persistArcSwapSuccessDismissal,
  persistArcSwapSuccessSummary,
  readArcSwapSuccess,
} from '../services/swap/successLifecycle';
import { formatArcSwapProviderFees, formatArcSwapQuoteDetails } from '../services/swap/quotePresentation';
import { ARC_SWAP_QUOTE_MAX_AGE_MS, canReviewArcSwap, canSubmitArcSwapQuote, getCurrentArcSwapQuote, isArcSwapQuoteFresh, isArcSwapReviewButtonDisabled, matchesArcSwapQuoteRequest, toggleArcSwapDirection } from '../services/swap/quoteState';
import { ArcSwapQuoteVerificationError, isArcSwapRouteUnavailableError } from '../services/swap/quoteVerification';
import { refreshArcSwapBalances } from '../services/swap/arcSwapBalanceRefresh';
import {
  isArcSwapReceiptAccountingCurrent,
  runArcSwapReceiptAccountingIfCurrent,
  type ArcSwapReceiptAccountingGenerationIdentity,
} from '../services/swap/receiptAccountingRetry';
import { ARC_TESTNET } from '../data/networks';
import type { ArcSwapSymbol } from '../types/swap';
import { TransactionSuccessScreen } from './TransactionSuccessScreen';
import { Button, Card, Label, TokenIcon } from './ui';
import { SlideToConfirm } from './SlideToConfirm';

const ARC_CHAIN_ID = 5042002;

function assetFor(symbol: ArcSwapSymbol): BaseAssetConfig & { address: `0x${string}` } {
  return symbol === 'USDC' ? ARC_USDC : ARC_EURC;
}

export function ArcSwapPage() {
  const { address, chainId, connector, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const queryClient = useQueryClient();
  const [providerState, setProviderState] = useState<{
    connector: NonNullable<typeof connector>;
    provider: EIP1193Provider;
  }>();
  const [direction, setDirection] = useState<{ tokenIn: ArcSwapSymbol; tokenOut: ArcSwapSymbol }>({
    tokenIn: 'USDC',
    tokenOut: 'EURC',
  });
  const { tokenIn, tokenOut } = direction;
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(50);
  const [now, setNow] = useState(Date.now());
  const [showReview, setShowReview] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [successPersistenceError, setSuccessPersistenceError] = useState<string | null>(null);
  const [successPersistenceRetry, setSuccessPersistenceRetry] = useState(0);
  const [mode, setMode] = useState<'token' | 'fx'>('token');
  const [completedAt, setCompletedAt] = useState<number>();
  const [successSnapshot, setSuccessSnapshot] = useState<{
    quote: SwapEstimate;
    inputAsset: BaseAssetConfig & { address: `0x${string}` };
    outputAsset: BaseAssetConfig & { address: `0x${string}` };
  }>();

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
      : rawAmount !== null && balance.isError
        ? `Unable to verify the ${tokenIn} balance. Refresh the balance before swapping.`
        : rawAmount !== null && (balance.isLoading || balance.isFetching)
          ? `Checking the ${tokenIn} balance...`
          : rawAmount !== null && rawAmount > balance.raw
        ? `Insufficient ${tokenIn} balance.`
        : null;
  const amountForQuote = !amountError && rawAmount !== null ? amount : '';
  const quoteQuery = useArcSwapQuote({ provider, providerConnector: providerForCurrentConnector?.connector, tokenIn, tokenOut, amountIn: amountForQuote, slippageBps });
  const refetchQuote = quoteQuery.refetch;
  const isNoRouteError = isArcSwapRouteUnavailableError(quoteQuery.error);
  const matchesCurrentRequest = (candidate: NonNullable<typeof quoteQuery.quote>) => matchesArcSwapQuoteRequest(candidate, {
    tokenIn,
    tokenOut,
    amountIn: amountForQuote,
    chainIn: 'Arc_Testnet',
    chainOut: 'Arc_Testnet',
    fromAddress: address,
    toAddress: address,
  });
  const availableQuote = getCurrentArcSwapQuote(quoteQuery, isNoRouteError, matchesCurrentRequest);
  const quoteUpdatedAt = quoteQuery.dataUpdatedAt;
  useEffect(() => {
    if (!quoteUpdatedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [quoteUpdatedAt]);
  const quoteFresh = Boolean(
    availableQuote &&
    !quoteQuery.isError &&
    !quoteQuery.isFetching &&
    quoteQuery.isSuccess &&
    isArcSwapQuoteFresh(quoteUpdatedAt, now),
  );
  const visibleQuote = quoteFresh ? availableQuote : undefined;
  const quoteDetails = visibleQuote ? formatArcSwapQuoteDetails(visibleQuote, slippageBps) : undefined;
  const quoteExpiresInSeconds = visibleQuote
    ? Math.max(0, Math.ceil((quoteUpdatedAt + ARC_SWAP_QUOTE_MAX_AGE_MS - now) / 1000))
    : undefined;
  useEffect(() => {
    if (availableQuote && quoteUpdatedAt && !quoteFresh && !quoteQuery.isError && !quoteQuery.isFetching) {
      void refetchQuote();
    }
  }, [availableQuote, quoteFresh, quoteQuery.isError, quoteQuery.isFetching, quoteUpdatedAt, refetchQuote]);
  const refreshConfirmedBalances = useCallback(async (
    identity: ArcSwapReceiptAccountingGenerationIdentity,
    isCurrent: () => boolean,
  ) => {
    if (identity.walletAddress.toLowerCase() !== address?.toLowerCase() || !isCurrent()) return;
    try {
      const hasError = await refreshArcSwapBalances(inputBalance.refetch, outputBalance.refetch);
      if (identity.walletAddress.toLowerCase() !== address?.toLowerCase() || !isCurrent()) return;
      if (hasError) {
        setValidationError('Swap confirmed, but one or more Arc Testnet token balances could not be refreshed.');
      }
    } catch (error) {
      if (identity.walletAddress.toLowerCase() !== address?.toLowerCase() || !isCurrent()) return;
      setValidationError(
        `Swap confirmed, but Arc Testnet token balance refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }, [address, inputBalance.refetch, outputBalance.refetch]);
  const execution = useArcSwapExecution(refreshConfirmedBalances);
  const resetExecution = execution.reset;
  const persistedSuccess = useMemo(
    () => address && execution.transactionHash
      ? readArcSwapSuccess(address, execution.transactionHash)
      : { record: null, error: null },
    [address, execution.transactionHash],
  );
  const receiptAccountingIsCurrent = Boolean(
    execution.state === 'confirmed' &&
    isArcSwapReceiptAccountingCurrent(
      execution.receiptAccountingIdentity,
      address,
      execution.transactionHash,
      execution.receiptAccountingCurrentGeneration,
    ),
  );
  const currentReceiptAccounting = receiptAccountingIsCurrent ? execution.receiptAccounting : null;
  const persistedSuccessKeysRef = useRef(new Set<string>());
  const successDismissed = isArcSwapSuccessDismissed(persistedSuccess.record);
  const successCompletedAt = currentReceiptAccounting?.completedAt
    ?? persistedSuccess.record?.summary?.completedAt
    ?? completedAt;
  const successSummary = useMemo(() => {
    const saved = persistedSuccess.record?.summary;
    const accounting = currentReceiptAccounting;
    if (!successSnapshot && !accounting && !saved) return undefined;
    const quotedProviderFee = successSnapshot
      ? formatArcSwapProviderFees(successSnapshot.quote)
      : null;
    return {
      amountSold: accounting?.amountSold ?? saved?.amountSold ?? 'Not verified',
      inputToken: accounting
        ? { symbol: accounting.inputToken, color: accounting.inputToken === 'USDC' ? ARC_USDC.color : ARC_EURC.color }
        : successSnapshot
          ? { symbol: successSnapshot.inputAsset.symbol, color: successSnapshot.inputAsset.color }
          : saved!.inputToken,
      amountReceived: accounting?.amountReceived ?? saved?.amountReceived ?? null,
      actualReceivedVerified: Boolean(accounting || saved?.actualReceivedVerified),
      outputToken: accounting
        ? { symbol: accounting.outputToken, color: accounting.outputToken === 'USDC' ? ARC_USDC.color : ARC_EURC.color }
        : successSnapshot
          ? { symbol: successSnapshot.outputAsset.symbol, color: successSnapshot.outputAsset.color }
          : saved!.outputToken,
      completedAt: accounting?.completedAt ?? successCompletedAt ?? Date.now(),
      expectedOutput: successSnapshot
        ? `${successSnapshot.quote.estimatedOutput.amount} ${successSnapshot.quote.estimatedOutput.token}`
        : saved?.expectedOutput ?? null,
      minimumReceived: accounting
        ? `${accounting.minimumReceived} ${accounting.outputToken}`
        : successSnapshot
          ? `${successSnapshot.quote.stopLimit.amount} ${successSnapshot.quote.stopLimit.token}`
        : saved?.minimumReceived ?? null,
      providerFee: quotedProviderFee ??
        (accounting?.providerFee
          ? `${accounting.providerFee} ${accounting.inputToken}`
          : saved?.providerFee ?? 'Not reported by route'),
      gasPaid: accounting
        ? accounting.gasPaid === null ? null : `${accounting.gasPaid} ${ARC_TESTNET.nativeCurrency.symbol}`
        : saved?.gasPaid ?? null,
      usdcBalanceBefore: accounting?.usdcBalanceBefore ?? null,
      usdcBalanceAfter: accounting?.usdcBalanceAfter ?? null,
      netUsdcBalanceChange: accounting
        ? accounting.netUsdcBalanceChange === null ? null : `${accounting.netUsdcBalanceChange} USDC`
        : null,
    };
  }, [currentReceiptAccounting, persistedSuccess.record?.summary, successCompletedAt, successSnapshot]);
  useEffect(() => {
    if (execution.state === 'confirmed' && execution.transactionHash) {
      setCompletedAt((current) => current ?? persistedSuccess.record?.summary?.completedAt ?? Date.now());
    } else if (execution.state !== 'confirmed') {
      setCompletedAt(undefined);
    }
  }, [execution.state, execution.transactionHash, persistedSuccess.record?.summary?.completedAt]);
  useEffect(() => {
    if (persistedSuccess.error) setValidationError(persistedSuccess.error);
  }, [persistedSuccess.error]);
  useEffect(() => {
    if (
      execution.state === 'confirmed' &&
      execution.transactionHash &&
      address &&
      currentReceiptAccounting &&
      execution.receiptAccountingIdentity?.walletAddress.toLowerCase() === address.toLowerCase() &&
      execution.receiptAccountingIdentity.transactionHash.toLowerCase() === execution.transactionHash.toLowerCase() &&
      execution.receiptAccountingIdentity.generation === execution.receiptAccountingCurrentGeneration &&
      successSummary
    ) {
      const persistenceKey = `${address.toLowerCase()}:${execution.transactionHash.toLowerCase()}`;
      if (!persistedSuccessKeysRef.current.has(persistenceKey)) {
        const error = runArcSwapReceiptAccountingIfCurrent(
          execution.receiptAccountingIdentity,
          address,
          execution.transactionHash,
          execution.receiptAccountingCurrentGeneration,
          () => persistArcSwapSuccessSummary(address, execution.transactionHash!, successSummary),
        );
        if (error) {
          setSuccessPersistenceError(error.message);
          setValidationError(`Swap confirmed, but its success summary could not be saved: ${error.message}`);
        } else {
          persistedSuccessKeysRef.current.add(persistenceKey);
          setSuccessPersistenceError(null);
          setValidationError((current) => current?.startsWith('Swap confirmed, but its success summary could not be saved:') ? null : current);
        }
      }
    }
  }, [address, currentReceiptAccounting, execution.receiptAccountingCurrentGeneration, execution.receiptAccountingIdentity, execution.state, execution.transactionHash, successPersistenceRetry, successSnapshot, successSummary]);
  const swapLocked = ['pending', 'executing', 'confirming', 'timeout', 'rpc-error', 'uncertain'].includes(execution.state);
  const clearSwapInputState = () => {
    setCompletedAt(undefined);
    setSuccessSnapshot(undefined);
    setSuccessPersistenceError(null);
    setShowReview(false);
    setValidationError(null);
    resetExecution();
  };
  const canReview = canReviewArcSwap({
    query: quoteQuery,
    isUnavailableRoute: isNoRouteError,
    quoteFresh,
    matchesCurrentRequest,
    isConnected,
    isArcTestnet: chainId === ARC_CHAIN_ID,
    hasProvider: Boolean(provider),
    hasValidAmount: Boolean(rawAmount && rawAmount > 0n && !amountError),
  });

  const changeDirection = () => {
    clearSwapInputState();
    setDirection((current) => toggleArcSwapDirection(current));
    setAmount('');
  };

  const execute = async () => {
    if (!canReview || !canSubmitArcSwapQuote(quoteQuery, isNoRouteError, quoteFresh, matchesCurrentRequest) || !availableQuote || !amountForQuote || !isArcSwapQuoteFresh(quoteUpdatedAt)) {
      setValidationError(quoteErrorText ?? 'No verified current quote is available. Review and submission are disabled.');
      void refetchQuote();
      throw new Error('A verified current Arc Swap quote is not available.');
    }
    setValidationError(null);
    setCompletedAt(undefined);
    setSuccessSnapshot({
      quote: availableQuote,
      inputAsset: { ...inputAsset, symbol: String(availableQuote.tokenIn) },
      outputAsset: { ...outputAsset, symbol: String(availableQuote.estimatedOutput.token) },
    });
    await execution.execute({
      provider,
      quote: availableQuote,
      tokenIn,
      tokenOut,
      amountIn: amountForQuote,
      slippageBps,
      quoteAmountIn: availableQuote.amountIn,
      quoteUpdatedAt,
      quoteIsCurrent: !quoteQuery.isError && !quoteQuery.isFetching && quoteQuery.isSuccess && Boolean(availableQuote) && isArcSwapQuoteFresh(quoteUpdatedAt),
    });
    void queryClient.invalidateQueries({ queryKey: ['prices'] });
  };

  const resetSwap = () => {
    clearSwapInputState();
    setAmount('');
  };

  const dismissSuccess = () => {
    if (!address || !execution.transactionHash) {
      setValidationError('Swap success details are unavailable; the confirmed transaction has been preserved.');
      return;
    }
    const dismissalError = dismissArcSwapSuccess({
      persistDismissal: () => persistArcSwapSuccessDismissal(
        address,
        execution.transactionHash!,
        successSummary,
      ),
      resetExecution,
      setAmount,
      setShowReview,
      setValidationError,
      clearQuoteSnapshot: () => setSuccessSnapshot(undefined),
      clearCompletedAt: () => setCompletedAt(undefined),
      invalidateQuote: () => queryClient.removeQueries({ queryKey: quoteQuery.queryKey, exact: true }),
    });
    if (dismissalError) {
      setValidationError(`Success popup could not be dismissed safely: ${dismissalError.message}`);
    }
  };
  const successPopupActions = createArcSwapSuccessPopupActions(dismissSuccess);

  const quoteErrorText = isNoRouteError
    ? quoteQuery.error instanceof ArcSwapQuoteVerificationError
      ? quoteQuery.error.message
      : 'No swap route is currently available for this pair on Arc Testnet. Please try again later.'
    : quoteQuery.isError
    ? quoteQuery.error instanceof ArcSwapQuoteVerificationError
      ? quoteQuery.error.message
      : 'Unable to get a swap quote right now. Please try again.'
    : null;

  const statusText = isNoRouteError
    ? quoteErrorText
    : validationError
      ?? execution.error?.message
      ?? (execution.state === 'executing' ? 'Executing swap...' : null)
      ?? (execution.state === 'confirming' || execution.state === 'pending' ? 'Confirming swap on Arc Testnet...' : null)
      ?? (execution.state === 'confirmed' && !successDismissed && execution.receiptAccountingError
        ? execution.receiptStatusVerified
          ? 'Transaction confirmed, but token transfer logs could not verify the swap amounts. Actual amounts are not shown.'
          : 'The transaction receipt could not be verified. Actual swap amounts are not shown.'
        : null)
      ?? (execution.state === 'confirmed' && execution.receiptAccountingLoading ? 'Retrying receipt verification...' : null)
      ?? (execution.state === 'confirmed' && !successDismissed && !execution.receiptAccounting ? 'Checking the confirmed transaction receipt...' : null)
      ?? (execution.state === 'confirmed' && !successDismissed ? 'Swap confirmed.' : null)
      ?? amountError
      ?? (chainId !== ARC_CHAIN_ID && isConnected ? 'Switch to Arc Testnet before swapping.' : null)
      ?? quoteErrorText
      ?? (!availableQuote && amountForQuote ? 'Requesting a live Arc Testnet quote...' : null)
      ?? (availableQuote && !quoteFresh ? 'Swap quote expired. Request a fresh quote.' : null)
      ?? (execution.recovered && execution.state === 'confirmed' && !successDismissed ? 'Saved Arc Swap transaction receipt confirmed.' : null);
  const canStartNewSwap = (execution.state === 'reverted' || (execution.state === 'confirmed' && successDismissed)) && Boolean(execution.transactionHash);

  const successAcknowledgementLoaded = Boolean(
    address &&
    execution.transactionHash &&
    currentReceiptAccounting !== null &&
    execution.receiptAccountingIdentity?.generation === execution.receiptAccountingCurrentGeneration &&
    persistedSuccess.error === null,
  );
  const completion = getArcSwapCompletionTransition(
    execution.state,
    execution.transactionHash,
    successDismissed,
    successAcknowledgementLoaded,
  );
  const reviewButtonDisabled = isArcSwapReviewButtonDisabled(
    canReview,
    canStartNewSwap,
    swapLocked,
    Boolean(execution.transactionHash),
  );
  if (completion) {
    return (
      <TransactionSuccessScreen
        title="Swap Successful!"
        description={(
          <>
            Your token swap was confirmed on Arc Testnet. Actual received amounts are decoded from verified token transfer logs.
            <span className="mt-2 block">
              Expected output (estimate): {successSummary?.expectedOutput ?? 'Quote estimate not retained'}.
              Minimum received: {successSummary?.minimumReceived ?? 'Not available'}.
              Provider fees: {successSummary?.providerFee ?? 'Not reported by route'}.
            </span>
            {validationError && <span className="mt-2 block text-amber-300">{validationError}</span>}
            {successPersistenceError && (
              <button
                type="button"
                className="mt-2 block text-amber-200 underline"
                onClick={() => setSuccessPersistenceRetry((retry) => retry + 1)}
              >
                Retry saving verified swap details
              </button>
            )}
          </>
        )}
        amountLabel="Amount sold"
        amount={successSummary?.amountSold ?? 'Not verified'}
        token={successSummary?.inputToken ?? inputAsset}
        secondaryAmount={successSummary ? {
          label: 'Received (actual)',
          amount: successSummary.amountReceived ?? 'Not verified',
          token: successSummary.outputToken,
        } : undefined}
        networks={[{ label: 'Network', network: { id: ARC_CHAIN_ID, name: 'Arc Testnet' } }]}
        transactionHash={execution.transactionHash!}
        transactionLabel="Transaction hash"
        successChimeKey={`arc-swap:${execution.transactionHash}`}
        explorerUrl={completion.explorerUrl}
        networkGasFee={successSummary?.gasPaid ?? 'Not reported by receipt'}
        completedAt={currentReceiptAccounting?.completedAt ?? null}
        primaryLabel="Back to Swap"
        onBack={successPopupActions.onBack}
        onPrimary={successPopupActions.onPrimary}
      />
    );
  }

  return (
    <div className="orbit-action-page orbit-arc-swap-page mx-auto max-w-4xl space-y-6">
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
                <select value={tokenIn} disabled={swapLocked} onChange={(event) => { clearSwapInputState(); setDirection((current) => ({ ...current, tokenIn: event.target.value as ArcSwapSymbol })); setAmount(''); }} className="min-w-0 flex-1 bg-transparent font-bold text-white outline-none">
                  {ARC_SWAP_ASSETS.map((asset) => <option key={asset.symbol} value={asset.symbol} disabled={asset.symbol === tokenOut} className="bg-[#101725]">{asset.symbol}</option>)}
                </select>
              </div>
              <span className="mt-2 block font-mono text-[10px] text-slate-500">Balance {balance.isError ? 'Unavailable' : balance.isFetching ? '...' : formatUnits(balance.raw, inputAsset.decimals)} {tokenIn}</span>
            </label>
            <button type="button" onClick={changeDirection} disabled={swapLocked} aria-label="Swap direction" className="mx-auto rounded-xl border border-white/10 bg-[#141d2e] px-3 py-2 text-cyan-300 disabled:opacity-50">⇄</button>
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-slate-400">To</span>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.04] p-3">
                <TokenIcon symbol={tokenOut} color={outputAsset.color} />
                <select value={tokenOut} disabled={swapLocked} onChange={(event) => { clearSwapInputState(); setDirection((current) => ({ ...current, tokenOut: event.target.value as ArcSwapSymbol })); setAmount(''); }} className="min-w-0 flex-1 bg-transparent font-bold text-white outline-none">
                  {ARC_SWAP_ASSETS.map((asset) => <option key={asset.symbol} value={asset.symbol} disabled={asset.symbol === tokenIn} className="bg-[#101725]">{asset.symbol}</option>)}
                </select>
              </div>
              <span className="mt-2 block font-mono text-[10px] text-slate-500">Balance {outputBalance.isError ? 'Unavailable' : outputBalance.isFetching ? '...' : formatUnits(outputBalance.raw, outputAsset.decimals)} {tokenOut}</span>
            </label>
          </div>

          <label className="mt-5 block">
            <span className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-400"><span>Amount</span><button type="button" disabled={swapLocked} onClick={() => { clearSwapInputState(); setAmount(formatUnits(balance.raw, inputAsset.decimals)); }} className="orbit-form-max font-mono text-[10px] disabled:opacity-50">MAX</button></span>
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={amount} disabled={swapLocked} onChange={(event) => { clearSwapInputState(); setAmount(event.target.value); }} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-2xl font-bold text-white outline-none placeholder:text-slate-600 disabled:opacity-60" /><span className="font-mono text-xs text-slate-500">{tokenIn}</span></div>
          </label>

          <div className="mt-5 space-y-3 rounded-xl border border-white/10 bg-white/[.03] p-4 text-xs">
            <div className="flex justify-between"><span className="text-slate-500">Executable route</span><span className="font-mono text-slate-200">{quoteDetails?.route ?? 'Unavailable'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Expected output</span><span className="font-mono text-slate-200">{isNoRouteError ? 'Unavailable' : quoteQuery.isLoading || quoteQuery.isFetching ? 'Loading...' : quoteDetails?.expectedOutput ?? 'Unavailable'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Minimum received</span><span className="font-mono text-slate-200">{quoteDetails?.minimumReceived ?? 'Unavailable'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Provider fees</span><span className="font-mono text-right text-slate-200">{isNoRouteError ? 'Unavailable' : quoteDetails?.providerFees ?? 'Unavailable'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Estimated gas</span><span className="font-mono text-right text-slate-200">{isNoRouteError ? 'Unavailable' : quoteDetails?.estimatedGas ?? 'Unavailable'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Quote expiry</span><span className="font-mono text-slate-200">{quoteExpiresInSeconds === undefined ? 'Unavailable' : `in ${quoteExpiresInSeconds}s`}</span></div>
            <div className="flex items-center justify-between"><span className="text-slate-500">Slippage</span><select value={slippageBps} disabled={swapLocked} onChange={(event) => setSlippageBps(Number(event.target.value))} className="rounded border border-white/10 bg-[#101725] px-2 py-1 font-mono text-[10px] text-slate-300"><option value={10}>0.1%</option><option value={50}>0.5%</option><option value={100}>1%</option></select></div>
          </div>

          {statusText && (
            <div className="mt-4 space-y-2 text-xs">
              <p className={isNoRouteError || quoteQuery.isError || execution.error || validationError || amountError ? 'text-rose-300' : 'text-slate-400'}>{statusText}</p>
              {execution.state === 'confirmed' && execution.receiptAccountingError && execution.transactionHash && (
                <a
                  href={`${ARC_TESTNET.blockExplorers.default.url}/tx/${execution.transactionHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-mono text-cyan-300 underline"
                >
                  Transaction hash: {execution.transactionHash}
                </a>
              )}
              {execution.state === 'confirmed' && execution.transactionHash &&
                (execution.receiptAccountingError || execution.receiptAccountingLoading) && (
                  <Button
                    variant="secondary"
                    className="w-full"
                    disabled={execution.receiptAccountingLoading}
                    onClick={() => void execution.retryReceiptAccounting()}
                  >
                    {execution.receiptAccountingLoading ? 'Verifying receipt...' : 'Retry verification'}
                  </Button>
                )}
            </div>
          )}
          <Button className={`mt-5 w-full ${reviewButtonDisabled ? 'disabled:grayscale disabled:brightness-75 disabled:cursor-not-allowed' : ''}`} onClick={() => canStartNewSwap ? resetSwap() : setShowReview(true)} disabled={reviewButtonDisabled} icon>{canStartNewSwap ? 'Start a new swap' : execution.state === 'executing' ? 'Executing swap...' : execution.state === 'confirming' || execution.state === 'pending' ? 'Confirming swap...' : execution.state === 'confirmed' ? 'Swap confirmed' : 'Review Swap'}</Button>
          {showReview && visibleQuote && quoteDetails && (
            <div className="mt-4 space-y-3 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4 text-xs">
              <Label>Final confirmation</Label>
              <div className="mt-3 space-y-2">
                <div className="flex justify-between gap-3"><span className="text-slate-500">Route</span><span>{tokenIn} → {tokenOut}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">Provider</span><span>{quoteDetails.route}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">Network</span><span>Arc Testnet</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">You pay</span><span>{visibleQuote.amountIn} {visibleQuote.tokenIn}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">Expected output (estimate)</span><span>{quoteDetails.expectedOutput}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">Minimum received</span><span>{quoteDetails.minimumReceived}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">Provider fees</span><span>{quoteDetails.providerFees}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">Estimated gas</span><span>{quoteDetails.estimatedGas}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">Slippage</span><span>{quoteDetails.slippage}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-500">Quote expiry</span><span>{quoteExpiresInSeconds === undefined ? 'Unavailable' : `in ${quoteExpiresInSeconds}s`}</span></div>
              </div>
              <p className="rounded-lg border border-white/10 bg-white/[.025] px-3 py-2.5 leading-5 text-slate-400">
                Review your wallet prompts. Approval and swap may require separate gas fees.
              </p>
              <SlideToConfirm
                label="Slide to swap"
                confirmationKey={`${address?.toLowerCase() ?? ''}:${chainId ?? ''}:${tokenIn}:${tokenOut}:${amount}:${slippageBps}:${quoteQuery.dataUpdatedAt}`}
                phase={execution.state === 'executing' ? 'submitting' : execution.state === 'pending' || execution.state === 'confirming' ? 'pending' : execution.state === 'confirmed' ? 'success' : execution.state === 'failed' ? 'failed' : 'idle'}
                disabled={!canReview || Boolean(execution.transactionHash) || !canSubmitArcSwapQuote(quoteQuery, isNoRouteError, quoteFresh, matchesCurrentRequest)}
                onConfirm={execute}
              />
              <Button variant="secondary" className="w-full" disabled={swapLocked || Boolean(execution.transactionHash)} onClick={() => setShowReview(false)}>Cancel review</Button>
            </div>
          )}
          {execution.transactionHash && !successDismissed && <p className="mt-3 text-xs text-emerald-300">Transaction: <a className="underline" href={getArcSwapCompletionTransition('confirmed', execution.transactionHash)?.explorerUrl} target="_blank" rel="noopener noreferrer">{execution.transactionHash.slice(0, 10)}...{execution.transactionHash.slice(-8)}</a></p>}
          {execution.transactionHash && ['pending', 'timeout', 'rpc-error'].includes(execution.state) && <Button variant="secondary" className="mt-3 w-full" onClick={() => void execution.retryRecoveryCheck()}>Check saved transaction</Button>}
          {(execution.state === 'failed' || quoteQuery.isError || isNoRouteError) && <Button variant="secondary" className="mt-3 w-full" onClick={() => { setShowReview(false); void refetchQuote(); }}><RefreshCw size={14} />Request fresh quote</Button>}
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
