import type { SwapEstimate } from '@circle-fin/swap-kit';

type ArcSwapQuoteAmounts = Pick<SwapEstimate, 'estimatedOutput' | 'stopLimit' | 'fees' | 'route'>;

export function formatArcSwapProviderFees(quote: Pick<SwapEstimate, 'fees'>): string | null {
  const providerFees = (quote.fees ?? []).filter((fee) => fee.type !== 'gas');
  return providerFees.length
    ? providerFees
      .map((fee) => `${fee.type}: ${fee.amount === null ? `Not reported (${fee.token})` : `${fee.amount} ${fee.token}`}`)
      .join(', ')
    : null;
}

export function formatArcSwapQuoteDetails(quote: ArcSwapQuoteAmounts, slippageBps: number) {
  const fees = quote.fees ?? [];
  const providerName = quote.route?.provider.toLowerCase() === 'lifi'
    ? 'LI.FI'
    : quote.route?.provider;
  const routeSteps = quote.route?.steps.map((step) => step.toolName).filter(Boolean).join(' → ');
  return {
    route: providerName
      ? `${providerName}${routeSteps ? ` · ${routeSteps}` : ''}`
      : 'Unavailable',
    expectedOutput: `${quote.estimatedOutput.amount} ${quote.estimatedOutput.token}`,
    minimumReceived: `${quote.stopLimit.amount} ${quote.stopLimit.token}`,
    providerFees: formatArcSwapProviderFees(quote) ?? 'Not provided by route',
    estimatedGas: fees.filter((fee) => fee.type === 'gas').length
      ? fees.filter((fee) => fee.type === 'gas')
        .map((fee) => fee.amount === null ? `Unavailable (${fee.token})` : `${fee.amount} ${fee.token}`)
        .join(', ')
      : 'Unavailable',
    slippage: `${(slippageBps / 100).toFixed(2)}%`,
  };
}
